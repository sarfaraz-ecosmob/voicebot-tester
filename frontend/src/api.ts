/// <reference types="vite/client" />

export const API: string = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

export type Run = {
  id: number;
  scenario_name?: string;
  status: string;
  result: any;
  created_at?: string;
};

export type Health = {
  status: string;
  mode: string;
  version: string;
  ai: { configured: boolean; model: string | null };
};

export type Scenario = {
  id: string;
  name: string;
  description: string;
  version?: number;
  timezone?: string;
  required_fields: string[];
  mock_slot: { date: string; time: string; available: boolean };
  assertions: string[];
};

export type Recording = { name: string; size_bytes: number; created_at: string };

export type AsteriskStatus = {
  connected: boolean;
  version?: string | null;
  channels?: { id?: string; name?: string; state?: string }[];
  error?: string;
};

export type Summary = {
  total: number;
  by_status: Record<string, number>;
  by_mode: Record<string, number>;
  pass_rate: number | null;
  tokens: { calls: number; prompt: number; completion: number; total: number };
  avg_duration_ms: number | null;
  latest_id: number | null;
};

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function reportUrl(id: number, format: "html" | "json" | "csv", download = false): string {
  return `${API}/api/reports/${id}?format=${format}&download=${download}`;
}

export function newRunKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `rk-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function fmtDuration(ms?: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDate(iso?: string): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
