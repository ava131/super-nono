/**
 * 外链白名单（评审 Q7-1）。
 *
 * ## 为什么单独一个纯函数
 *
 * 这段判断是**安全边界**，但它原本写在 `ipc.js` 的 `ipcMain.handle` 里 ——
 * 而那个文件 import 了 `electron`，在纯 Node 测试环境里跑不起来。
 * 抽成纯函数放进 `shared/` 之后，它可以被直接单测（T22），
 * 而 `ipc.js` 仍然只负责"把校验结果变成 IPC 响应"。
 *
 * ## 为什么必须校验
 *
 * 气泡窗是个 `frame: false` 的 `BrowserWindow`：没有地址栏、没有后退。
 * 渲染端直接 `<a href="...">` 点击后会把**整个应用界面导航走**，
 * 用户看到桌宠"变成"了一个网页，而且**回不来**。
 *
 * 而气泡里要渲染的链接来自 **issue 标题所在的同一条数据流** ——
 * 也就是**外部不可信内容**。所以只能放行 `https:` + `github.com`。
 */

/** 允许打开外链的域名（精确匹配，不做后缀匹配——`evil-github.com` 必须被拒） */
export const ALLOWED_EXTERNAL_HOSTS = Object.freeze(['github.com']);

/**
 * 判断一个 URL 是否允许交给系统浏览器打开。
 *
 * 两条都必须满足：**协议是 https** 且 **主机名在白名单里**。
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isAllowedExternalUrl(url) {
  if (typeof url !== 'string' || url === '') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return ALLOWED_EXTERNAL_HOSTS.includes(parsed.hostname);
}
