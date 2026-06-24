# git-safe-commit-tool

一个独立的本地浏览器工具，用来对指定 Git 仓库执行更安全的提交、变基、冲突处理和推送前检查流程。它不依赖 Codex skill 输入框运行，日常操作都在浏览器 UI 中完成。

## 快速启动

要求：Windows、Git、Node.js 18+。

最简单的启动方式：

```powershell
.\start-git-safe-commit.bat
```

脚本会自动：

- 检查 Node.js/npm。
- 首次运行时安装依赖。
- 按 `config.json` 的端口打开浏览器；没有配置时默认打开 `http://127.0.0.1:19347`。
- 启动本地服务。

也可以手动启动：

```powershell
npm install
npm start
```

默认地址：

```text
http://127.0.0.1:19347
```

## 首次配置

打开页面后进入设置页，填写：

- `repoPath`：要操作的目标 Git 仓库绝对路径。
- AI Provider：Codex、Claude 或 Gemini。
- `baseUrl` / `apiKey` / `model`：对应供应商的接口配置。
- `workflow.requireConfirmBeforePush`：是否在推送前强制人工确认，建议保持开启。

配置会保存到本地 `config.json`。该文件已被 `.gitignore` 忽略，不要提交真实 API Key 或个人仓库路径。

可以参考 `config.example.json` 创建自己的配置。

## 分发给别人

推荐把整个目录发给对方，或放到一个内部 Git 仓库。对方只需要：

```powershell
git clone <your-repo-url>
cd git_safe_commit_tool
.\start-git-safe-commit.bat
```

如果不是通过 Git 分发，也可以压缩整个目录，但建议不要包含：

- `node_modules/`
- `config.json`
- `dist/`
- `output/`

对方首次启动后在页面里配置自己的仓库路径和 API Key。

## 打包

生成可分发 zip：

```powershell
.\package-release.bat
```

脚本会依次执行：

- `npm test`
- `npm run build`
- 复制运行时文件到 `output/git-safe-commit-tool/`
- 生成 `output/git-safe-commit-tool-<时间戳>.zip`

zip 不包含 `config.json`、`node_modules/`、`.git/`、`src/`、`test/`。接收方解压后运行：

```powershell
.\start-git-safe-commit.bat
```

## 安全边界

这个工具的核心目标是保护 Git 操作边界：

- 不执行 `git pull`。
- 不执行 `git reset --hard`。
- 不执行 `git clean`。
- 不执行 `git stash pop`。
- 不执行 force push。
- Git 命令统一走 `execFile("git", args)` 参数数组，不拼 shell 字符串。
- rebase-capable 工作流前必须创建恢复点。
- Excel、Unity 资源、二进制、密钥、签名文件和语义冲突需要人工确认。

## 验证

```powershell
npm test
```
