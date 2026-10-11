import type { BehaviorField, Outcome } from "../shared/types.ts";

export function money(cents: number | undefined): string {
	if (cents === undefined || cents === null) return "–";
	const sign = cents < 0 ? "−" : "";
	return `${sign}€${(Math.abs(cents) / 100).toFixed(2)}`;
}

export const FIELD_LABELS: Record<BehaviorField, string> = {
	subtotal: "Subtotal",
	discount: "Discount",
	shipping: "Shipping",
	tax: "Tax",
	total: "Total",
	giftCard: "Gift card",
	due: "Due",
	points: "Points",
};

export function fieldValue(field: BehaviorField, outcome: Outcome): string {
	if ("error" in outcome) return "";
	const v = outcome[field];
	if (v === undefined) return "–";
	return field === "points" ? String(v) : field === "discount" && v > 0 ? `−${money(v)}` : money(v);
}

export function ago(at: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h`;
}

export function clock(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const POSITION_COLORS = ["#3567a6", "#b8860b", "#7a55c2", "#1d7a6c", "#c0563a", "#5b7f2a"];

export function positionColor(positionId: string | undefined): string {
	if (!positionId) return "var(--line-strong)";
	const n = Number(positionId.replace(/\D/g, "")) || 1;
	return POSITION_COLORS[(n - 1) % POSITION_COLORS.length];
}
