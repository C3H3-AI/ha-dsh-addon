# Changelog

本 addon 的版本变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
