# Changelog

## [0.4.0] - 2026-09-03

### Added
- 引入 ESLint 与 `typecheck:strict`，CI 现在自动执行 lint / strict typecheck / test / build。
- README 增加“已知限制与边界”“升级说明”“开发与质量门禁”章节。
- 增加 0.3.x → 0.4.0 的迁移说明与验证覆盖。

### Changed
- Logo 改为 PNG 资源导入，减少源码内嵌大段 base64。
- 清理未使用 import / 参数 / 变量，移除无调用方的 `textarea` UI 分支。
- 移除公开 Service API、向量字段、旧 `auto` 来源与无用素材。
- 存储领域迁移到 v3：旧 `auto` 统一归一到 `agent`，移除 `embedding` / `embeddingAt`。

### Fixed
- 修复短字母 token 误命中（如 `md` 不再误匹配 `amd` / `systemd`）。
- 增强凭据形态串过滤，密码/IP 片段不再误召回敏感记忆。

### Removed
- 移除硬触发捕获（`记住：` / `请记住` 固定句式自动落库）。
- 移除 Dock 预览组件与相关样式。

## [0.3.5] - 2026-09-02

- 修复 extractQuery 粘贴回显误召回。
- 增加凭据形态串过滤。
- 修复短 token 误命中。
