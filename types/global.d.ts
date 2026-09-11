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

  onState(fn: (payload: { turnId: string; state: string }) => void): () => void;
  onDelta(fn: (payload: { turnId: string; text: string }) => void): () => void;
  onMessage(fn: (payload: unknown) => void): () => void;
  onNotice(fn: (payload: unknown) => void): () => void;
  onError(fn: (payload: unknown) => void): () => void;
  onConfirmRequest(fn: (payload: unknown) => void): () => void;
  onMetrics(fn: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    api: NonoApi;
  }
}
