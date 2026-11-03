# TEST_REPORT — dsh-desktop-ark 0.2.1（真机，rc.5）

- **需求**：101-version-0.2.1 ｜ **工程**：dsh-desktop-ark（HarmonyOS Edition：ArkWeb + 进程内 libnode）
- **设备**：HAD-W32（HarmonyOS PC / 2in1），HarmonyOS 7.0.0.111 / API 26，3120×2080
- **基线**：dsh `dsh-v0.2.1-rc.5`｜HAP 0.2.1 / versionCode 201｜bundle `org.fellow99.dsh.DshDesktopArk`｜引擎 libnode v24.2.0（ohpm）
- **驱动**：hdc（`aa start`/`snapshot_display`/`uitest uiInput`）+ **ArkWeb DevTools**（`setWebDebuggingAccess(true)` 已开 → `hdc fport tcp:9223 localabstract:webview_devtools_remote_<pid>` → Playwright `connectOverCDP`，Chrome/144 ArkWeb 7.0）
- **日期**：2026-11-03

## 一、构建/签名阻塞（已解决，根因记录）

`assembleHap` 的 `SignHap` 一直失败：
```
ERROR: 11012006 File IO failed
Error Message: Invalid CEN header (invalid zip64 extra data field size)
```

**根因：hvigor 调用的 `java` 取自 PATH（本机是 sdkman Temurin 21），而 hap-sign-tool 需要 DevEco 自带 JBR。**
用同一命令行换成 `deveco-studio-6/jbr/bin/java.exe` 执行 `hap-sign-tool sign-app` → **签名成功**；
把 `jbr/bin` 前置到 PATH 再跑 `hvigorw` → **BUILD 产出 `entry-default-signed.hap`（92.0 MB）**。

- 排查中已排除：材料/bundle 名（`verify-profile` 均 success 且 bundle-name 一致）、载荷（移除 resfile 46MB）、原生库（移除 4 个 .so）、压缩方式（`compressNativeLibs=false` 174MB STORED）、debug/release 两种 buildMode、zip 重打包、两套 SDK。
- 对照：hos 的 `build-hap.ps1` 本来就把 JBR 前置 PATH，所以 hos 一直能签。
- **建议**：`scripts/build-hap.sh` 也应像 hos 那样前置 `$CLT/jbr/bin`（或在文档里写明必须用 JBR），否则在装了其它 JDK 的机器上必然踩坑。

## 二、功能测试（真机，真实 API KEY）

| ID | 用例 | 结果 | 证据 |
|---|---|---|---|
| AR1 | 设置 DeepSeek API KEY | ✅ | 设置→模型→保存，toast「已保存 DeepSeek (deepseek-official)。」 |
| AR2 | 沙箱中创建工作区测试目录 | ✅ | 添加工作区→沙箱→新建文件夹 `ws-ark-test`→打开；三根（沙箱/文档/下载）符合清单 #34 |
| AR3 | 文本对话「介绍一下你自己」 | ✅ | 完整自述 + 「你正在通过 Web GUI `http://127.0.0.1:42159` 与我对话」，**4 秒** |
| AR4 | 图片分析对话（**原生选择器选图**） | ✅ | 「+」→文件→原生选择器（个人›下载）→`camera-lens-damage-replacement.png`(2.3MB)→打开→缩略图 1448×1086 正常→发送；模型给出「损坏→更换」维修场景的整体判断、逐元素清点（相机模组/替换镜头/镊子/螺丝刀/台面）与破损形态分析（放射+同心环裂纹、镀膜紫红反光、崩边碎屑），**21 秒** |

## 三、端侧环境能力自检（agent 实操 14 项）

结论（agent 自评 + 我侧核验）：
- ✅ **3 项全通**：#1 新建/写入/读回、#2 覆盖读回、#12 `git init + commit`（commit `d7256443a3526a822c232bab65ae6a71fc6c5970`，4 个文件已入库）
- ⚠️ **部分成功**：#7 子目录（`cap/sub/d.txt` 写入成功，删除动作受 shell 缺失限制）、#14 环境信息（工作区绝对路径 `/data/storage/el2/base/haps/entry/files/workspace/ws-ark-test` 报出，权限模式读数受阻）
- ❌ **其余失败**，统一根因：**`/system/bin/sh` 不可执行 + `ripgrep` 启动失败** → 影响 #3 列目录、#4 复制、#5 重命名、#6 删除、#8 chmod、#9 shell、#10 内容搜索、#11 后台任务、#13 子智能体（子代理遭遇同一组故障，明确拒绝猜测）

**与《docs/能力对照清单.md》完全一致**：
- #11 shell：清单记「执行器+围栏已交付；`assertExecutable` 的 statSync/realpathSync 预检对 sh EACCES ⇒ 工具当前失败（P1，可修）」→ 实测确认。
- #14/#15 grep/glob：清单记「载荷无 `bin/rg` ⇒ 调用即失败（P1 待纯 JS 后端）」→ 实测确认。
- #22 job_*：启动依赖 bash → 随 shell 缺失一并失败。
- #13 子智能体：进程内 spawn 可用，但子代理继承同样的 shell/rg 缺口。

> 注：文件系统写入经 `ctx.fs` 围栏可用（#1/#2/#7 写入成功、git commit 成功），**失败集中在 shell 与 ripgrep 两条通道**，与清单结论一致，不属新缺陷。

## 四、发现的产品问题（待修）

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| AR-A | **首屏标题重复**：主区显示「DSH Desktop DSH Desktop 预览版」 | 截图（`ark-a1.jpeg` / 启动后 DOM 文本 `DSH Desktop | DSH Desktop | 预览版`） | 品牌化回归；与 android 版 ③（hero 槽位结构变化导致上游 titleGroup 未隐藏）同类，ark 的 `205-plugin-branding` 需补同款选择器兼容 |
| AR-B | `scripts/build-hap.sh` 未前置 JBR | 见 §一 | 在非纯 JBR 环境（如装了 sdkman JDK）必然签名失败，且错误信息极具误导性 |

## 五、安全

- API KEY 仅运行时注入（env → 设置界面），未落盘脚本/文档/提交/日志。
- `build-profile.json5` 内含 DevEco 写入的签名凭证（cert/p12/profile 路径 + 加密口令）→ **不得提交**；材料本体在 gitignored 的 `signing.*.local.json` / `.ohos/config/`。
- 排查过程中临时抓取的 `hap-sign-tool` 命令行（含明文口令）仅存于 `D:\tmp-hap\`（工作区外），未写入仓库/日志。
