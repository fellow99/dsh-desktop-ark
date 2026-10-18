# `@dsh-ohos/workspace-picker`

`ctx.directoryPicker` 的 HarmonyOS 实现：四个主目录 + 根围栏，列目录/建目录**全部复用上游 browse 原语**。

## 形态

- 服务：`class OhosDirectoryPicker extends Service`，`super(ctx, 'directoryPicker')`（seam：`packages/host/directory-picker/src/index.ts:104-113`）。
- `capability()` 返回**稳定**对象：`{ kind:'browse', list(path?, signal?), createDirectory(path, name) }`，与 wire 控制器（`packages/api/workspace-controller/src/directory-picker.ts`）的 3 个 verb 对应。
- 列表结果额外携带 `root`（当前根 id）、`roots`（四个根描述）、`fencedOut`（被围栏拦掉的条目数，>0 时出现）。

## 四个主目录

| id | 路径 | 来源 |
|---|---|---|
| `sandbox` | `config.sandboxRoot` / `DSH_OHOS_WORKSPACE` | 不存在时 `mkdir -p`（FR-106-003） |
| `desktop` | `<userRoot>/Desktop` | `config.userRoot` / `DSH_OHOS_USER_ROOT` |
| `documents` | `<userRoot>/Documents` | 同上 |
| `download` | `<userRoot>/Download` | 同上 |

`config.roots` 决定暴露哪几个用户根（bundle 行里是三项）。任一路径不是绝对路径 ⇒ 插件构造失败（`resolveRoots` 抛错），**绝不回退到 `process.cwd()`**。

## 根围栏（安全属性）

- 拒绝相对路径、NUL、任何 `..` 段；
- 目标必须落在某个根内（canonical 后再判），否则 `DirectoryPickerError('directory-unreadable', …)`；
- 列表条目若 `realpath` 后逃出根（符号链接），被剔除并计数（`fencedOut`）；
- 面包屑截断到根（`truncateCrumbs`），根之上不渲染；
- 没有“手输路径”入口：capability 只接受浏览器产生的绝对路径。

## 委派与 `directory-picker/unavailable`

两个插件不能注册同名 cordis 服务（`vendor/cordis/src/reflect.ts:289-291`）。本包因此：

1. 若当前作用域已有别的 `directoryPicker` provider，直接用它的 browse capability；
2. 否则把上游 `@deepseek-ai/dsh-host-directory-picker-browse` 挂进 **isolated 子上下文**（`ctx.isolate('directoryPicker')`），避免与自己的注册冲突；
3. 加载不到时抛 `DirectoryPickerError`，消息以 `directory-picker/unavailable:` 开头——**不降级、不空列表**。

> 集成注意：bundle 目前同时插入 `directory-picker-browse` 与 `workspace-picker` 两行，两者都注册 `ctx.directoryPicker`，在同一作用域会撞名。本包已把内部挂载放进 isolated 作用域，因此**不依赖** browse 行；但 browse 行与 workspace-picker 行并存时，后注册者仍会因重名失败。合并前需禁用 browse 行（或把它也放进 isolated 作用域）。

## 授权门（partial）

`list`/`createDirectory` 遇到 `EACCES`/`EPERM` 时，经宿主桥 `perm.check` → `perm.request`（600 s）申请对应权限，成功后重试一次；失败/被拒则抛带 `permission`/`hint` 的错误。桥不可用时保留原始错误并附加 `hint`。

未实现：`perm.openAppInfo` 的 UI 入口（客户端面负责）。

## 配置

| 键 | 说明 |
|---|---|
| `sandboxRoot` | 绝对路径；默认 `DSH_OHOS_WORKSPACE` |
| `userRoot` | 绝对路径；默认 `DSH_OHOS_USER_ROOT` |
| `roots` | `['desktop','documents','download']` 的子集 |

## 已知限制

- 客户端面（两个 `directoryFlow` 槽、Miller 列、记忆主目录）**未实现**：本包只提供宿主面 seam；React 面属 `specs/106` 的其余部分。
- 未做“切换主目录整栈重置”等 UI 语义（客户端职责）。
- 目录列表的隐藏条目仍由后端返回（`hidden: true`），隐藏渲染是客户端职责（FR-106-009）。
