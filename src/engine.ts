/**
 * Deterministic money engine. Pure functions over the shop export in data/demo-shop.
 * Agents never do money arithmetic themselves: every RUB number on the board must match a value
 * computed here (the Critic re-computes it independently and rejects anything off by more than 1 %).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const MARKETPLACES = ["ozon", "wb", "ym"] as const
export type Marketplace = (typeof MARKETPLACES)[number]
export const MP_LABEL: Record<Marketplace, string> = { ozon: "Ozon", wb: "Wildberries", ym: "Yandex Market" }

export const LEAK_KINDS = ["margin", "returns", "ads_out_of_stock", "ads_drr", "overstock", "penalty"] as const
export type LeakKind = (typeof LEAK_KINDS)[number]

type Op = { sku: string; type: "sale" | "return"; price: number; commission: number; acquiring: number; logistics: number; returnLogistics: number }
type Deduction = { sku: string | null; kind: string; amount: number }
type Ad = { campaign: string; sku: string; spend: number; attributedRevenue: number }
type Stock = { sku: string; units: number; avgOrdersPerDay: number }
type Shop = { shop: string; period: { from: string; to: string; days: number }; taxRate: number; targetMarginPerUnit: number; targetDrr: number }

export const DATA_DIR = process.env.WARROOM_DATA ?? join(process.cwd(), "data", "demo-shop")
const load = <T>(...p: string[]): T => JSON.parse(readFileSync(join(DATA_DIR, ...p), "utf8"))

export const shop = load<Shop>("shop.json")
const costs = load<{ sku: string; name: string; cogs: number }[]>("costs.json")
export const skuName = (sku: string | null) => (sku ? (costs.find((c) => c.sku === sku)?.name ?? sku) : "whole store")

const r0 = (x: number) => Math.round(x)
const r2 = (x: number) => Math.round(x * 100) / 100

export type SkuMetrics = {
	sku: string
	name: string
	unitsSold: number
	unitsReturned: number
	buyoutRate: number
	revenueRub: number
	unitProfitRub: number
	marginGapRub: number
	returnCostRub: number
	adSpendRub: number
	adRevenueRub: number
	drr: number | null
	adOverspendRub: number
	stockUnits: number
	avgOrdersPerDay: number
	daysOfCover: number | null
	storageRub: number
	/** price that would give exactly the target margin per unit, at current fee shares and logistics */
	minPriceForTargetRub: number | null
}

export type MarketplaceMetrics = {
	marketplace: Marketplace
	period: Shop["period"]
	targets: { marginPerUnitRub: number; drr: number; minBuyoutRate: number; maxDaysOfCover: number }
	skus: SkuMetrics[]
	penaltiesRub: number
	penaltiesCount: number
}

export const TARGETS = { minBuyoutRate: 0.7, maxDaysOfCover: 90 }

export function marketplaceMetrics(mp: Marketplace): MarketplaceMetrics {
	const ops = load<Op[]>(mp, "operations.json")
	const ded = load<Deduction[]>(mp, "deductions.json")
	const ads = load<Ad[]>(mp, "ads.json")
	const stocks = load<Stock[]>(mp, "stocks.json")
	const skus = costs.map(({ sku, name, cogs }) => {
		const sales = ops.filter((o) => o.sku === sku && o.type === "sale")
		const rets = ops.filter((o) => o.sku === sku && o.type === "return")
		const unitsSold = sales.length
		const revenue = sales.reduce((s, o) => s + o.price, 0)
		const saleProfit = sales.reduce((s, o) => s + o.price - o.commission - o.acquiring - o.logistics - cogs - shop.taxRate * o.price, 0)
		const returnCost = rets.reduce((s, o) => s + o.logistics + o.returnLogistics, 0)
		const unitProfit = unitsSold ? (saleProfit - returnCost) / unitsSold : 0
		const skuAds = ads.filter((a) => a.sku === sku)
		const adSpend = skuAds.reduce((s, a) => s + a.spend, 0)
		const adRevenue = skuAds.reduce((s, a) => s + a.attributedRevenue, 0)
		const stock = stocks.find((s) => s.sku === sku) ?? { units: 0, avgOrdersPerDay: 0 }
		const feeShare = revenue ? sales.reduce((s, o) => s + o.commission + o.acquiring, 0) / revenue : 0
		const logisticsPerUnit = unitsSold ? sales.reduce((s, o) => s + o.logistics, 0) / unitsSold : 0
		const minPrice = unitsSold ? (cogs + logisticsPerUnit + shop.targetMarginPerUnit + returnCost / unitsSold) / (1 - feeShare - shop.taxRate) : null
		const storage = ded.filter((d) => d.sku === sku && d.kind === "storage").reduce((s, d) => s + d.amount, 0)
		return {
			sku,
			name,
			unitsSold,
			unitsReturned: rets.length,
			buyoutRate: unitsSold + rets.length ? r2(unitsSold / (unitsSold + rets.length)) : 1,
			revenueRub: r0(revenue),
			unitProfitRub: r2(unitProfit),
			marginGapRub: unitsSold ? r0(Math.max(0, shop.targetMarginPerUnit - unitProfit) * unitsSold) : 0,
			returnCostRub: r0(returnCost),
			adSpendRub: r0(adSpend),
			adRevenueRub: r0(adRevenue),
			drr: adSpend ? (adRevenue ? r2(adSpend / adRevenue) : null) : 0,
			adOverspendRub: r0(Math.max(0, adSpend - shop.targetDrr * adRevenue)),
			stockUnits: stock.units,
			avgOrdersPerDay: stock.avgOrdersPerDay,
			daysOfCover: stock.avgOrdersPerDay ? r0(stock.units / stock.avgOrdersPerDay) : null,
			storageRub: r0(storage),
			minPriceForTargetRub: minPrice === null ? null : Math.ceil(minPrice / 10) * 10,
		}
	})
	const pens = ded.filter((d) => d.kind.startsWith("penalty"))
	return {
		marketplace: mp,
		period: shop.period,
		targets: { marginPerUnitRub: shop.targetMarginPerUnit, drr: shop.targetDrr, ...TARGETS },
		skus,
		penaltiesRub: r0(pens.reduce((s, d) => s + d.amount, 0)),
		penaltiesCount: pens.length,
	}
}

/** The one place that decides whether (mp, sku, kind) is a real leak and how many RUB/month it costs. */
export function leakValue(mp: Marketplace, sku: string | null, kind: LeakKind): { isLeak: boolean; lossRub: number; why: string } {
	const m = marketplaceMetrics(mp)
	if (kind === "penalty") return { isLeak: m.penaltiesRub > 0, lossRub: m.penaltiesRub, why: `${m.penaltiesCount} penalties` }
	const s = m.skus.find((x) => x.sku === sku)
	if (!s) return { isLeak: false, lossRub: 0, why: `unknown sku ${sku}` }
	switch (kind) {
		case "margin":
			return { isLeak: s.unitsSold > 0 && s.unitProfitRub < shop.targetMarginPerUnit, lossRub: s.marginGapRub, why: `unit profit ${s.unitProfitRub} ${s.unitProfitRub < shop.targetMarginPerUnit ? "<" : "≥"} target ${shop.targetMarginPerUnit}` }
		case "returns":
			return { isLeak: s.buyoutRate < TARGETS.minBuyoutRate, lossRub: s.returnCostRub, why: `buyout ${s.buyoutRate} ${s.buyoutRate < TARGETS.minBuyoutRate ? "<" : "≥"} ${TARGETS.minBuyoutRate}` }
		case "ads_out_of_stock":
			return { isLeak: s.stockUnits === 0 && s.adSpendRub > 0, lossRub: s.adSpendRub, why: `stock ${s.stockUnits}, ad spend ${s.adSpendRub}` }
		case "ads_drr":
			return { isLeak: s.stockUnits > 0 && s.adOverspendRub > 0, lossRub: s.adOverspendRub, why: `stock ${s.stockUnits}, DRR ${s.drr} ${s.adOverspendRub > 0 ? ">" : "≤"} ${shop.targetDrr}` }
		case "overstock":
			return { isLeak: (s.daysOfCover ?? 0) > TARGETS.maxDaysOfCover, lossRub: s.storageRub, why: `${s.daysOfCover} days of cover ${(s.daysOfCover ?? 0) > TARGETS.maxDaysOfCover ? ">" : "≤"} ${TARGETS.maxDaysOfCover}` }
	}
}

/** Reference answer: every leak the engine sees (used by tests and the "missed" section of the report). */
export function allLeaks() {
	const out: { marketplace: Marketplace; sku: string | null; kind: LeakKind; lossRub: number; why: string }[] = []
	for (const mp of MARKETPLACES) {
		const m = marketplaceMetrics(mp)
		for (const kind of LEAK_KINDS) {
			const skus = kind === "penalty" ? [null] : m.skus.map((s) => s.sku)
			for (const sku of skus) {
				const v = leakValue(mp, sku, kind)
				if (v.isLeak && v.lossRub > 0) out.push({ marketplace: mp, sku, kind, lossRub: v.lossRub, why: v.why })
			}
		}
	}
	return out.sort((a, b) => b.lossRub - a.lossRub)
}
