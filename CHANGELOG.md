# Changelog

本 addon 的版本变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.29] - 2026-08-29

### 移除

- **proxy.js — 移除 `mobileCss` 移动端 CSS 注入**：移动端适配改由 `dsh-mobile-fix` 插件负责，代理不再注入移动端样式，避免与插件冲突。
- **proxy.js — 移除 `updateUiScript` 一键更新 UI 注入**：不再往 DSH 设置页面注入版本/更新按钮。

## [0.2.28] - 2026-08-27

### 修复

- **proxy.js — React 创建的 `<iframe>` 加载失败**：`dsh-mcp-connector` 的 iframe 由 React/JSX 创建，其 `src` 通过 `Element.setAttribute("src", ...)` 设置，**不会触发** `HTMLIFrameElement.prototype.src` 的 setter。此前只 hook 了 src setter，导致 React 创建的 iframe 仍以不带 Ingress 前缀的绝对路径加载而返回 404。
  - 现新增 hook `Element.prototype.setAttribute`：当以 `src` 属性设置时同样补上 Ingress 前缀，彻底修复 MCP 连接器页面 404 的问题。

## [0.2.27] - 2026-08-27

### 修复

- **proxy.js — HA Ingress 下的动态资源加载**：修复在 HA Ingress 反向代理下，多个插件动态注入的资源因绝对路径不带 Ingress 前缀而加载失败的问题。
  - `dsh-mcp-connector` 的 iframe 页面（`/mcp-connector/ui/`）此前会返回 404；现已通过 hook `HTMLIFrameElement` 的 `src` 补上 Ingress 前缀。
  - `dsh-better-sidebar` 的懒加载 chunk（`/sidebar/bundle/*.js`）此前返回 403/404；现已通过 hook `HTMLScriptElement` 的 `src` 补上 Ingress 前缀。
- **proxy.js — WebSocket 连接**：`rewrite()` 的跨源判断由"比较完整 origin"改为"只比较 host（hostname:port）"，避免 `wss://` 与页面 `https://` 因协议不同被误判为跨源而跳过前缀补写，从而修复终端等 WebSocket 连接失败（如 1006）的问题。
- **proxy.js — query 参数保留**：URL 重写时保留 `?query` 参数，避免带查询串的请求丢失参数。

### 改进

- **run.sh — 启动自愈**：每次启动 addon 时自动检测并修复 `proxy.js`（幂等）。即使容器重建后 `proxy.js` 被镜像还原成旧版，也能自动恢复为包含 HA Ingress 修复的正确版本，避免上述问题复发。

### 文档

- **addon 描述与首页链接**：`config.yaml` 与 `Dockerfile` 中 addon 的描述改为"DeepSeek Harness Home Assistant 加载项"，"更多详情"链接指向本 addon 仓库，便于使用者查看源码与使用说明。

## [0.2.26]

- 初始/上一正式版本。见仓库历史提交记录。
