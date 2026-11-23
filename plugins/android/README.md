# 安卓模拟器（bridge 插件 `android`）

工作区里的「安卓」卡：看着安卓模拟器（或用 USB / 无线调试连在服务器电脑上的真机）的实时画面直接操作；卡片放宽后左边画面、右边是 Android Studio 式的工具。
Claude、dimensio、Antigravity、ChatGPT（Codex）也拿到一个 `android` 工具，用同一台设备装包、点按、截图、读日志、录屏。

- 只对服务器主机开放。需要 bridge **8.83** 以上（插件接口六期：实时通道 `ctx.socket`、工作区卡片进各分页、插件工具给 Codex）。
- 服务器电脑上要有 Android SDK（platform-tools、emulator、cmdline-tools、至少一个系统镜像和一台虚拟设备），Windows 要开硬件加速。缺什么卡片空态会说，也可以让 Claude 调 `android` 工具的 `doctor`。
- 设置：SDK 位置、画质、无人使用多少分钟后自动关机、最多同时开几台、给不给 agent 工具。

## 能做什么

- **画面**：scrcpy H.264 画面流经插件实时通道推给页面，WebCodecs 解码；鼠标、多指触摸、键盘、中文输入（剪贴板粘贴）、滚轮；右键返回、中键主页。
- **子页**：Logcat（级别 / 应用 / 关键词过滤、暂停、清空）、应用（启停清卸、拖 apk 安装）、文件（浏览、下载、上传）、控制（定位、电池、旋转、折叠、短信、来电、指纹、网速）、快照、控件树（选中在画面上框出）。
- **其它**：录屏（最长 3 分钟）、新建 / 删除虚拟设备、冷启动、清空数据启动、无线调试配对连接。
- **agent 工具**：doctor / devices / start / stop / create_avd / install / launch / stop_app / open_url / apps / clear_data / uninstall / screen / ui_tree / tap / long_press / swipe / scroll / input / key / wait / logs / emu / snapshot / record；Claude 另有子 agent「android-operator」。
- **进程**：模拟器经 PowerShell 中转脱离 bridge 进程树启动、不弹窗口；bridge 重启或插件停用都不关模拟器，回来后按进程表认领；没人用到时限先存快照再关机；只停自己开的。

## 目录

```
bridge-plugin.json   清单（配置 schema、engines）
index.mjs            入口：接口、三个实时通道（events / stream / logcat）、agent 工具与说明、工作区卡片、手册
lib/                 sdk · adb · emulators · scrcpy · actions（agent 动作）· devices · record · prompts · config
vendor/              scrcpy-server v5.0.1（Apache-2.0，原样，sha256 764eb6f7…）
manual/android.md    并入 bridge 项目手册的章节
locales/en.json      英文界面（名称、设置）
page/                页面源码（Svelte）；构建出 web/
web/                 插件页面（构建产物，随包发布）
```

## 开发

- 页面：`node <claude-bridge>/web/node_modules/vite/bin/vite.js build --config page/vite.config.mjs`（`page/node_modules` 是指向 bridge 前端依赖的目录联接，不进包）。
- 单测：`node --test lib/lib.test.mjs page/lib/page.test.js`。
- 本机试装：设置 › 扩展 › 功能扩展 › 添加 › 本机目录，填这个目录；改了代码点「重新加载」。

## 第三方

scrcpy server © Genymobile / Romain Vimont，Apache License 2.0，全文见 `vendor/LICENSE-scrcpy.txt`。
