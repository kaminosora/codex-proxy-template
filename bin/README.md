# bin\ — 外部程序放这里

这个目录里的**大文件不进 git 仓库**（见项目根目录的 `.gitignore`）。
换台机器、或者别人克隆了仓库之后，需要自己把下面这些补进来。

| 文件 | 大小 | 作用 | 必需？ |
|---|---|---|---|
| `xray.exe` | ~34MB | xray 客户端，用来连服务器上的 VLESS+REALITY 入站 | 用 `xray:jp` 出口就需要 |
| `codex-core.exe` | ~45MB | **mihomo 内核的改名副本**，回落出口（`clash-party`）用它 | 用回落出口就需要 |
| `geoip.dat` / `geosite.dat` | ~19MB / 10MB | 内核的配套数据 | 跟着内核一起 |
| `wintun.dll` | ~0.4MB | xray 的 TUN 驱动（本项目**不用** TUN，可留可删） | 不需要 |
| `README-xray.md` / `LICENSE*` | 小 | xray 与 wintun 的官方说明与许可证 | 保留（合规） |

> 本目录**不会**被写入：内核与 xray 的运行时文件都落在 `run\` 下
> （`run\xray-client.json`、`run\fallback\config.yaml`、`run\fallback\cache.db`），
> 那些才是运行产物，已经在 `.gitignore` 里排除了。

---

## 一键补齐

在项目根目录执行：

```powershell
.\bin\fetch-binaries.ps1
```

它会做两件事：

1. **`codex-core.exe`** —— 从 Clash Party 的安装目录复制 `mihomo.exe` 过来并改名。
2. **`xray.exe` 与配套数据** —— 校验本地是否已有；没有就打印官方下载地址（版本要跟服务器匹配）。

---

## ★ 为什么 mihomo 内核必须改名成 `codex-core.exe` ★

Clash Party 启动时会做一个「高权限内核检测」，而那个检测**纯粹按进程名匹配**：

```
mihomo.exe / mihomo-alpha.exe / mihomo-smart.exe
```

它一旦发现有这些名字的进程在跑，就弹窗要求「以管理员模式重启」，
而那个弹窗**点取消 = Clash Party 直接退出**，点确认 = 提权并自动打开 TUN。

我们的回落出口也是 mihomo。如果不改名，就会出现：
**你开着这个工具，就再也打不开 Clash Party 了。**

改名是安全的 —— mihomo 不依赖自己的文件名。
`ClashPartyUplink.coreExe()` 也会**优先选** `bin\codex-core.exe`，
只在找不到时才退而求其次用 Clash Party 自带的（并打印警告）。

---

## xray 版本要求

- **REALITY 公钥的字段名在新老版本里不一样**：Xray 26.x 用 `password`，旧版用 `publicKey`。
  本项目两个都读、也都会写进生成的配置，所以两种版本都能用。
- 下载：https://github.com/XTLS/Xray-core/releases
  选 `Xray-windows-64.zip`，解压把 `xray.exe` 放到本目录。
- 配套的 `geoip.dat` / `geosite.dat` 在同一个压缩包里。

放好之后用这个命令确认：

```powershell
.\codex-proxy.ps1 check      # 出口 IP 应该是你服务器的 IP
.\codex-proxy.ps1 status     # 三个出口应显示 OK
```
