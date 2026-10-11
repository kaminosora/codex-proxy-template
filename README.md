# Codex 专用代理

让 **Codex** 的流量走你自己的日本服务器，而电脑上其它应用（浏览器、微信、DeepSeek 客户端……）
的网络**完全不受影响**。

```
其它应用 ──> 系统代理，保持原样，本工具绝不插手
Codex    ──> 127.0.0.1:17890 ──┬─ 1. SSH 隧道 ──> 你的日本服务器
                               ├─ 2. xray     ──> 你的日本服务器
                               └─ 3. 机场节点 ──> 回落（自动挑最快的）
```

## 为什么需要它

Codex 桌面应用是 Chromium 内核，**不读 `HTTPS_PROXY` 环境变量**；不给它 `--proxy-server` 参数时，
它会跟着 Windows 系统代理走——系统代理一关就**直连**，在国内网络下就会卡住、连不上云端环境。

本工具在 `127.0.0.1:17890` 起一个只有本机能连的小代理（同时支持 HTTP CONNECT 和 SOCKS5），
然后**只给 Codex 这一个进程**挂上它：桌面应用用 `--proxy-server` 启动参数，CLI 用环境变量。

**不修改系统代理、不碰 Clash Party、不开 TUN、不动路由表。**

## 快速开始

```powershell
cd C:\codex-proxy
.\codex-proxy.ps1 app        # 一条命令：启动代理 + 带代理启动 Codex
```

确认出口：

```powershell
.\codex-proxy.ps1 check      # 出口 IP 应为你日本服务器的 IP
```

## 三层出口

| 优先级 | 出口 | 说明 |
|---|---|---|
| 1 | `ssh:jp` | SSH 动态转发到你的服务器，无需服务器改动 |
| 2 | `xray:jp` | 走服务器 443 的 VLESS+REALITY 入站 |
| 3 | `clash-party` | 机场日本节点（独立 mihomo 实例，8 节点自动测速切换） |

每 15 秒探测一次，连续 2 次失败自动切到下一个健康出口。切换对 Codex 透明。

## 文档

| 文档 | 内容 |
|---|---|
| [使用手册.md](使用手册.md) | **怎么用**：首次使用、日常命令、配置说明、卸载 |
| [故障排查与说明.md](故障排查与说明.md) | **为什么**：故障排查、设计取舍、踩过的坑、实测记录 |
| [tests/README.md](tests/README.md) | **怎么验证**：测试脚本说明、预期结果、历史测试记录 |

## 文件

| 文件 | 作用 |
|---|---|
| `codex-proxy.ps1` | 入口脚本，日常只用这个 |
| `codex-proxy.mjs` | 守护进程（出口管理 + 本地桥接） |
| `codex-proxy.config.json` | 配置 |
| `bin\xray.exe` | xray 客户端 |
| `tests\` | 测试套件（21 个脚本 + 调度器），`.\codex-proxy.ps1 tests` 跑全部 |
| `logs\`、`run\` | 日志与运行状态（自动生成） |

## 卸载

```powershell
.\codex-proxy.ps1 down
cd ..
Remove-Item -Recurse -Force ai_proxy
```

不安装任何服务、驱动或注册表项，删目录即完全恢复。详见[使用手册第十二节](使用手册.md#十二卸载与回滚)。
