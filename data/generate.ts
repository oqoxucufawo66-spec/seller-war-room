/**
 * Synthetic demo shop for Seller War Room.
 * 100% invented data (no real seller, no real API dumps). Deterministic: same seed -> same files.
 * Shop: "Demo Tea House" selling tea & honey on Ozon, Wildberries and Yandex Market, 30 days.
 * A few money leaks are planted on purpose and listed in planted-issues.json (answer key for evals).
 *
 * Run: npx tsx data/generate.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const OUT = join(import.meta.dirname, "demo-shop")
const DAYS = 30
const START = new Date("2026-09-28T00:00:00Z")

// mulberry32 PRNG
let seed = 20261030
const rnd = () => {
	seed |= 0
	seed = (seed + 0x6d2b79f5) | 0
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const poisson = (lambda: number) => {
	let l = Math.exp(-lambda), k = 0, p = 1
	do { k++; p *= rnd() } while (p > l)
	return k - 1
}
const r2 = (x: number) => Math.round(x * 100) / 100
const day = (i: number) => new Date(START.getTime() + i * 86400000).toISOString().slice(0, 10)

type Sku = { sku: string; name: string; cogs: number; weightKg: number }
const SKUS: Sku[] = [
	{ sku: "TEA-BLK-100", name: "Black tea Assam 100 g", cogs: 95, weightKg: 0.12 },
	{ sku: "TEA-GRN-100", name: "Green tea Sencha 100 g", cogs: 110, weightKg: 0.12 },
	{ sku: "TEA-HRB-050", name: "Herbal mix Mountain 50 g", cogs: 60, weightKg: 0.07 },
	{ sku: "TEA-PUE-200", name: "Puer pressed 200 g", cogs: 240, weightKg: 0.25 },
	{ sku: "TEA-GFT-SET", name: "Gift set 4 teas", cogs: 520, weightKg: 0.6 },
	{ sku: "HNY-LIN-250", name: "Linden honey 250 g", cogs: 150, weightKg: 0.33 },
	{ sku: "HNY-BCK-500", name: "Buckwheat honey 500 g", cogs: 230, weightKg: 0.62 },
	{ sku: "ACC-INF-001", name: "Steel tea infuser", cogs: 70, weightKg: 0.05 },
	{ sku: "ACC-POT-600", name: "Glass teapot 600 ml", cogs: 480, weightKg: 0.9 },
	{ sku: "TEA-MAT-030", name: "Matcha ceremonial 30 g", cogs: 310, weightKg: 0.04 },
]

type MpCfg = {
	id: "ozon" | "wb" | "ym"
	price: Record<string, number>
	demand: Record<string, number> // orders/day
	commission: Record<string, number> // share of price
	buyout: Record<string, number> // share delivered (not returned/cancelled)
	logisticsPerUnit: (s: Sku) => number
	returnLogistics: number
	storagePerUnitDay: number
	stock: Record<string, number>
	acquiring: number
}

const base = (v: number) => Object.fromEntries(SKUS.map((s) => [s.sku, v]))

const MPS: MpCfg[] = [
	{
		id: "ozon",
		price: { "TEA-BLK-100": 390, "TEA-GRN-100": 420, "TEA-HRB-050": 290, "TEA-PUE-200": 890, "TEA-GFT-SET": 1890,
			"HNY-LIN-250": 490, "HNY-BCK-500": 590 /* LEAK: too cheap for heavy item */, "ACC-INF-001": 250, "ACC-POT-600": 1490, "TEA-MAT-030": 990 },
		demand: { ...base(3), "HNY-BCK-500": 9, "TEA-GFT-SET": 1.5, "ACC-POT-600": 1, "TEA-MAT-030": 2 },
		commission: { ...base(0.21), "ACC-POT-600": 0.24, "ACC-INF-001": 0.24 },
		buyout: base(0.9),
		logisticsPerUnit: (s) => 63 + 25 * Math.max(0, s.weightKg - 0.1) * 10,
		returnLogistics: 60,
		storagePerUnitDay: 0.35,
		stock: { ...base(120), "TEA-MAT-030": 0 /* LEAK: ads keep running while out of stock */ },
		acquiring: 0.015,
	},
	{
		id: "wb",
		price: { "TEA-BLK-100": 370, "TEA-GRN-100": 410, "TEA-HRB-050": 270, "TEA-PUE-200": 860, "TEA-GFT-SET": 1790,
			"HNY-LIN-250": 470, "HNY-BCK-500": 690, "ACC-INF-001": 240, "ACC-POT-600": 1390, "TEA-MAT-030": 950 },
		demand: { ...base(4), "TEA-GFT-SET": 2, "ACC-POT-600": 1.2 },
		commission: { ...base(0.245), "ACC-POT-600": 0.27 },
		buyout: { ...base(0.82), "ACC-POT-600": 0.38 /* LEAK: glass teapot comes back broken */ },
		logisticsPerUnit: (s) => 46 + 9 * Math.max(0, s.weightKg - 0.1) * 10,
		returnLogistics: 50,
		storagePerUnitDay: 0.5,
		stock: { ...base(150), "TEA-GFT-SET": 2400 /* LEAK: frozen overstock, storage burns money */ },
		acquiring: 0,
	},
	{
		id: "ym",
		price: { "TEA-BLK-100": 399, "TEA-GRN-100": 430, "TEA-HRB-050": 299, "TEA-PUE-200": 899, "TEA-GFT-SET": 1950,
			"HNY-LIN-250": 499, "HNY-BCK-500": 699, "ACC-INF-001": 259, "ACC-POT-600": 1490, "TEA-MAT-030": 1050 },
		demand: base(1.5),
		commission: base(0.18),
		buyout: base(0.93),
		logisticsPerUnit: (s) => 55 + 12 * Math.max(0, s.weightKg - 0.1) * 10,
		returnLogistics: 55,
		storagePerUnitDay: 0.3,
		stock: base(80),
		acquiring: 0.015,
	},
]

// Ads per marketplace (daily spend, attributed orders/day).
const ADS: Record<string, { campaign: string; sku: string; spendDay: number; ordersDay: number }[]> = {
	ozon: [
		{ campaign: "OZ-Search-Assam", sku: "TEA-BLK-100", spendDay: 120, ordersDay: 1.2 },
		{ campaign: "OZ-Matcha-Promo", sku: "TEA-MAT-030", spendDay: 450, ordersDay: 0 }, // LEAK: OOS
	],
	wb: [
		{ campaign: "WB-Auto-Teapot", sku: "ACC-POT-600", spendDay: 900, ordersDay: 0.6 }, // LEAK: DRR ~ 100%+
		{ campaign: "WB-Search-Honey", sku: "HNY-LIN-250", spendDay: 150, ordersDay: 1.5 },
	],
	ym: [{ campaign: "YM-Boost-Puer", sku: "TEA-PUE-200", spendDay: 90, ordersDay: 0.3 }],
}

mkdirSync(OUT, { recursive: true })
const write = (f: string, d: unknown) => writeFileSync(join(OUT, f), JSON.stringify(d, null, 1) + "\n")

write("shop.json", {
	shop: "Demo Tea House (synthetic)",
	period: { from: day(0), to: day(DAYS - 1), days: DAYS },
	currency: "RUB",
	taxRate: 0.06,
	targetMarginPerUnit: 80,
	targetDrr: 0.1,
	note: "Synthetic data generated by data/generate.ts. Not a real seller.",
})
write("costs.json", SKUS.map((s) => ({ sku: s.sku, name: s.name, cogs: s.cogs, weightKg: s.weightKg })))

for (const mp of MPS) {
	const rows: Record<string, unknown>[] = []
	let opId = 1
	for (let d = 0; d < DAYS; d++) {
		for (const s of SKUS) {
			const n = mp.stock[s.sku] === 0 ? 0 : poisson(mp.demand[s.sku])
			for (let k = 0; k < n; k++) {
				const price = mp.price[s.sku]
				const delivered = rnd() < mp.buyout[s.sku]
				const logistics = r2(mp.logisticsPerUnit(s))
				rows.push({
					operationId: `${mp.id.toUpperCase()}-${String(opId++).padStart(6, "0")}`,
					date: day(d),
					sku: s.sku,
					type: delivered ? "sale" : "return",
					price,
					commission: delivered ? r2(price * mp.commission[s.sku]) : 0,
					acquiring: delivered ? r2(price * mp.acquiring) : 0,
					logistics,
					returnLogistics: delivered ? 0 : mp.returnLogistics,
					payout: delivered ? r2(price * (1 - mp.commission[s.sku] - mp.acquiring) - logistics) : r2(-logistics - mp.returnLogistics),
				})
			}
		}
	}
	// storage & penalties as separate deductions
	const deductions: Record<string, unknown>[] = []
	for (let d = 0; d < DAYS; d++) {
		for (const s of SKUS) {
			const units = mp.stock[s.sku]
			if (units > 0) deductions.push({ date: day(d), sku: s.sku, kind: "storage", units, amount: r2(units * mp.storagePerUnitDay) })
		}
	}
	if (mp.id === "ym") {
		// LEAK: late shipments penalties
		for (const d of [3, 4, 11, 12, 13, 20, 26]) deductions.push({ date: day(d), sku: null, kind: "penalty_late_shipment", amount: 1500 })
	}
	const ads = ADS[mp.id].flatMap((c) =>
		Array.from({ length: DAYS }, (_, d) => {
			const orders = poisson(c.ordersDay)
			return { date: day(d), campaign: c.campaign, sku: c.sku, spend: r2(c.spendDay * (0.85 + rnd() * 0.3)), attributedOrders: orders, attributedRevenue: orders * mp.price[c.sku] }
		}),
	)
	const stocks = SKUS.map((s) => ({ sku: s.sku, units: mp.stock[s.sku], avgOrdersPerDay: mp.stock[s.sku] === 0 ? 0 : mp.demand[s.sku] }))
	mkdirSync(join(OUT, mp.id), { recursive: true })
	write(`${mp.id}/operations.json`, rows)
	write(`${mp.id}/deductions.json`, deductions)
	write(`${mp.id}/ads.json`, ads)
	write(`${mp.id}/stocks.json`, stocks)
	write(`${mp.id}/prices.json`, SKUS.map((s) => ({ sku: s.sku, price: mp.price[s.sku], commissionRate: mp.commission[s.sku] })))
}

write("planted-issues.json", [
	{ id: "oz-heavy-honey-below-target", marketplace: "ozon", sku: "HNY-BCK-500", kind: "margin", hint: "Price 590 does not cover cogs+commission+logistics+tax with target margin" },
	{ id: "oz-ads-out-of-stock", marketplace: "ozon", sku: "TEA-MAT-030", kind: "ads", hint: "Campaign spends ~450/day while stock is 0" },
	{ id: "wb-teapot-returns", marketplace: "wb", sku: "ACC-POT-600", kind: "returns", hint: "Buyout ~38%, return logistics eats margin" },
	{ id: "wb-teapot-ads-drr", marketplace: "wb", sku: "ACC-POT-600", kind: "ads", hint: "DRR far above 10% target" },
	{ id: "wb-giftset-overstock", marketplace: "wb", sku: "TEA-GFT-SET", kind: "storage", hint: "2400 units vs ~2/day sales: >3 years of stock" },
	{ id: "ym-late-shipment-penalties", marketplace: "ym", sku: null, kind: "penalty", hint: "7 penalties x 1500" },
])
console.log(`synthetic demo shop written to ${OUT}`)
