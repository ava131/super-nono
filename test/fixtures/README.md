# 测试 fixture 说明

> ⚠️ **这些是真实接口响应的存档，不是手编数据。**
> 目的是让 P1/P4 的测试**完全离线**——实测已证明反复打真实接口会被封 IP
> （`docs/market/PRD-market-v0.md` §12.1 第 4 条：开发调试一律用 fixture）。

---

## 1. `yahoo-600519.SS.json`

| 项 | 值 |
|---|---|
| 来源 | `https://query2.finance.yahoo.com/v8/finance/chart/600519.SS?range=1mo&interval=1d` |
| 抓取时间 | 2026-09-14 11:59 CST |
| 抓取环境 | **海外网络**（PM 开发机当时的位置） |
| 标的 | 贵州茅台 `600519.SS`（上交所） |
| 根数 | 22 |
| 含 `adjclose` | ✅ 是 |
| 保留字段 | `meta`（精简）、`timestamp`、`indicators.quote[0]`（OHLCV）、`indicators.adjclose[0]` |

**已验证的性质**（抓取当时实测）：

| 性质 | 值 | 意义 |
|---|---|---|
| `meta.currency` | `CNY` | 确认是 A 股 |
| `meta.exchangeName` | `SHH` | 上交所 |
| `meta.timezone` | `CST`，`gmtoffset` 28800 | UTC+8，与 A 股一致 |
| **末根 `adjclose / close`** | **1.000000** | ✅ **证实这是前复权口径**（最新价不变） |
| 首根 `adjclose / close` | 1.000000（本段区间内无除权） | 区间内恰好没有分红送转，故比值恒为 1 |

> ⚠️ **本 fixture 的一个重要局限**：该区间内**没有发生除权**，因此
> `adjclose === close` 全程成立，**无法用它验证复权换算是真的在起作用**。
> → 因此 `adjust.test.js` 里另造了**带已知除权点的合成数据**来验证换算逻辑，
> 本 fixture 只用于验证**解析形状**（真实 schema 兼容性）。
>
> MK3（除权案例验证）仍需在有真实除权标的时补做，见 `IMPLEMENTATION-STATUS.md`。

---

## 2. 维护约定

- **新增 fixture 必须在上表登记**：来源 URL、抓取时间、抓取环境（境内/境外）、根数、是否含 `adjclose`。
- **不要手改 fixture 内容** —— 那会失去"真实 schema"的价值，测试也会变成自说自话。
  需要构造边界场景（停牌、缺口、无 adjclose）时，**在测试代码里基于 fixture 派生**，不要改原文件。
- **不要为了测试去打真实接口**。
