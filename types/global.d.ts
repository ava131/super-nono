/**
 * preload 通过 contextBridge 暴露给渲染进程的 API 契约。
 *
 * 渲染进程**不认识任何 IPC 频道名**，只调用这里声明的方法。
 * 频道常量唯一存在于 src/shared/channels.cjs。
 */

export interface NonoApi {
  ready(): void;
  click(): void;
  dragStart(offsetX: number, offsetY: number): void;
  dragEnd(): void;
  setIgnoreMouse(ignore: boolean): void;
  toggleBubble(open: boolean): void;
  stateChanged(state: string): void;
  cancel(): void;
  sendMessage(text: string): void;
  confirmResponse(requestId: string, approved: boolean): void;

  settingsGet(keys: string[]): Promise<Record<string, unknown>>;
  settingsSet(key: string, value: unknown): Promise<unknown>;
  historyRecent(limit?: number): Promise<unknown>;
  sessionList(): Promise<unknown>;
  sessionNew(): Promise<unknown>;
  sessionSwitch(id: string): Promise<unknown>;
  sessionDelete(id: string): Promise<unknown>;
  sessionRename(id: string, title: string): Promise<unknown>;

  /**
   * 自选股名单（PRD-market §8）。
   *
   * ⚠️ **零出网**：只读本地 `skill_kv`，不碰任何行情接口。
   * 所以数据源挂掉、或用户开着飞行模式时，这个方法照样能用。
   */
  watchlistList(): Promise<unknown>;
  /** 删一支。由**用户点按钮**触发（不是模型调用）—— L1.5 不弹框后的"事后纠正"落点。 */
  watchlistRemove(symbol: string): Promise<unknown>;

  onState(fn: (payload: { turnId: string; state: string }) => void): () => void;
  onDelta(fn: (payload: { turnId: string; text: string }) => void): () => void;
  onMessage(fn: (payload: unknown) => void): () => void;
  onNotice(fn: (payload: unknown) => void): () => void;
  onError(fn: (payload: unknown) => void): () => void;
  onConfirmRequest(fn: (payload: unknown) => void): () => void;

  /**
   * 技能的结构化结果（`data`）—— 与 `onMessage` 走的是**两条不同的路**。
   *
   * `summary`（≤800 字符）回填给模型；`data` **不进模型上下文**，只到这里，
   * 由气泡渲染成完整可点击列表。所以列表长度不受 800 预算约束。
   *
   * ⚠️ 里面的 issue 标题是**外部不可信文本**，渲染时必须用 `textContent`。
   */
  onSkillResult(
    fn: (payload: { turnId: string; skill: string; data: unknown }) => void,
  ): () => void;

  onMetrics(fn: (payload: unknown) => void): () => void;

  /**
   * 用系统浏览器打开外链。
   *
   * 必须走这个方法而**不能**在渲染端直接 `<a href>`：气泡窗是 BrowserWindow，
   * 直接跳转会把整个应用界面导航走且回不来。主进程只放行 `https:` + `github.com`。
   */
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    api: NonoApi;
  }
}
