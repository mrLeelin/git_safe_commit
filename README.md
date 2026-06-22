# git-safe-commit-tool

独立浏览器工具，用于在本地仓库中执行安全的 git-safe-commit 工作流。它不依赖 Codex skill 输入框；用户通过浏览器按钮、状态面板、日志和确认区操作。

本工程内置一份参考 skill：`.kiro/skills/git-safe-commit`。浏览器工具不依赖该 skill 运行；它用于保留原始工作流、安全规则和冲突工作台设计。

## 启动

```powershell
node server.mjs
```

打开：

```text
http://127.0.0.1:8080
```

## 配置

打开页面后，在右侧 **设置** 面板填写 URL、API Key、模型和仓库路径，然后点击 **保存设置**。设置会写入本地 `config.json`。

`config.json` 是本地私有配置，已被本目录 `.gitignore` 忽略。不要提交真实 API Key。页面读取配置时会脱敏显示 Key；保存时如果 API Key 留空，会保留已经保存的 Key。

关键字段：

- `repoPath`：目标 Git 仓库绝对路径。
- `ai.baseUrl`：OpenAI 兼容 Chat Completions API 地址。
- `ai.apiKey`：本地 API Key。
- `ai.model`：模型名称。
- `workflow.requireConfirmBeforePush`：保留 push 前确认策略。

## 安全边界

- 不执行 `git pull`。
- 不执行 `git reset --hard`。
- 不执行 `git clean`。
- 不执行 `git stash pop`。
- 不执行 force push。
- 所有 Git 命令走 `execFile("git", args)`，不拼 shell 字符串。
- rebase 前必须创建恢复点。
- Excel、Unity 资源、二进制、密钥、签名文件和语义冲突需要人工确认。

## 验证

```powershell
npm test
```
