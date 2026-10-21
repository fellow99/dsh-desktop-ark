import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { webview } from '@kit.ArkWeb';
import BuildProfile from 'BuildProfile';
import { DshRuntime, LaunchPhase, LaunchSnapshot } from '../app/DshRuntime';

/**
 * 单页外壳：ArkWeb 承载 dsh Web UI；启动期间叠加加载/错误视图。
 *
 * 页面来源是本地 HTTP（`http://127.0.0.1:<port>/`），不是 `file://`、也不是 `data:`。
 */
@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private runtime: DshRuntime = DshRuntime.get();
  private attached: boolean = false;
  private historyCleared: boolean = false;
  private pendingUrl: string = '';

  @State phase: string = LaunchPhase.IDLE;
  @State statusText: string = '正在启动…';
  @State detail: string = '';
  @State showOverlay: boolean = true;

  aboutToAppear(): void {
    // 调试通道：debug 构建开启 ArkWeb 远程调试（CDP），release 关闭。
    if (BuildProfile.DEBUG) {
      try {
        webview.WebviewController.setWebDebuggingAccess(true);
      } catch (error) {
        // 平台不支持时忽略：只影响调试，不影响功能。
      }
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    this.runtime.launch(context, (snapshot: LaunchSnapshot): void => {
      this.phase = snapshot.phase;
      this.statusText = snapshot.message;
      this.detail = snapshot.detail;
      if (snapshot.url !== '') {
        this.pendingUrl = snapshot.url;
        this.showOverlay = false;
        this.loadPending();
      } else if (snapshot.phase === LaunchPhase.FAILED) {
        this.showOverlay = true;
      }
    });
  }

  private loadPending(): void {
    if (!this.attached || this.pendingUrl === '') {
      return;
    }
    try {
      this.controller.loadUrl(this.pendingUrl);
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      this.detail = `loadUrl 失败：${message}`;
      this.showOverlay = true;
    }
  }

  private openExternal(url: string): void {
    if (!url.startsWith('https://')) {
      return;
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.openLink(url).catch((error: BusinessError): void => {
      this.detail = `外部打开失败：${error.message}`;
    });
  }

  private exitApp(): void {
    this.runtime.shutdown('user-exit');
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.terminateSelf().catch((error: BusinessError): void => {
      this.detail = `退出失败：${error.message}`;
    });
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // RenderMode.SYNC_RENDER：ASYNC_RENDER 下 Web 是独立图形 surface 节点，真机上系统输入法
      // 窗口出现/关闭后该 surface 会脱离合成树（截图整片黑、DOM 仍正常），SYNC_RENDER 把内容
      // 作为画布节点与系统组件一起合成，规避该缺陷（HAD-W32 / API 26 实测）。
      Web({ src: $rawfile('boot.html'), controller: this.controller, renderMode: RenderMode.SYNC_RENDER })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(false)
        // 自动填充会拉起系统 AutoFillAbility 窗口，真机上会让 Web 表面变黑（HAD-W32/API26 实测）。
        // 关闭后输入框仍可正常键入；调试亦可用 CDP。
        .enableAutoFill(false)
        // 导航围栏（FR-UI-003 / FR-103-008）：只放行本机服务；外链交给系统。
        .onLoadIntercept((event: OnLoadInterceptEvent): boolean => {
          const url: string = event.data.getRequestUrl();
          if (url === 'about:blank' || url.startsWith('http://127.0.0.1:') || url.startsWith('data:')) {
            return false;
          }
          this.openExternal(url);
          return true;
        })
        .onErrorReceive((event: OnErrorReceiveEvent): void => {
          this.detail = `页面加载失败：${event.error.getErrorInfo()}`;
          this.showOverlay = true;
        })
        .onControllerAttached((): void => {
          this.attached = true;
          this.loadPending();
        })
        .onPageEnd((): void => {
          // 只清一次：清掉启动页（boot.html），不打断 dsh 前端自身的回退栈。
          if (this.historyCleared) {
            return;
          }
          try {
            this.controller.clearHistory();
            this.historyCleared = true;
          } catch (error) {
            // 页面尚未形成历史时忽略；不影响功能。
          }
        })

      if (this.showOverlay) {
        Column({ space: 12 }) {
          Text('DSH Desktop Ark')
            .fontSize(20)
            .fontWeight(FontWeight.Medium)
          Text(this.phase)
            .fontSize(12)
            .fontColor('#888888')
          Text(this.statusText)
            .fontSize(16)
            .textAlign(TextAlign.Center)

          if (this.detail !== '') {
            Scroll() {
              Text(this.detail)
                .fontSize(12)
                .fontFamily('monospace')
                .width('100%')
                .copyOption(CopyOptions.LocalDevice)
            }
            .width('86%')
            .height(260)
            .borderRadius(8)
            .backgroundColor('#F5F5F5')
            .padding(12)
          }

          if (this.phase === LaunchPhase.FAILED) {
            Button('重启应用')
              .width(160)
              .onClick((): void => {
                this.exitApp();
              })
            Text('退出后重新打开应用即可重试（进程内运行时不可重启）')
              .fontSize(11)
              .fontColor('#888888')
              .textAlign(TextAlign.Center)
          }
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#FFFFFF')
      }
    }
    .width('100%')
    .height('100%')
  }
}
