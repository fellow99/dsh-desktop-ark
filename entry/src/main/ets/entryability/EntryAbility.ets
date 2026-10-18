import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { DshRuntime } from '../app/DshRuntime';
import { Constants } from '../common/Constants';

/**
 * 应用入口。
 *
 * 生命周期约定（宪法 C4）：
 * - 单实例由 `module.json5` 的 `launchType: singleton` 保证；
 * - 退出不拦截（`onPrepareToTerminate` 返回 `false`），只通知运行时收尾；
 * - 窗口只加载 `pages/Index`，渲染交给 ArkWeb。
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', 'EntryAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    const promise: Promise<void> = windowStage.loadContent('pages/Index');
    promise.then(() => {
      hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', 'window stage content loaded');
    }).catch((error: BusinessError) => {
      hilog.error(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, 'loadContent failed: %{public}s', error.message);
    });
  }

  onPrepareToTerminate(): boolean {
    DshRuntime.get().shutdown('user-exit');
    // 不拦截系统终止：进程内 Node 没有优雅停止接口，拖延只会让系统强杀。
    return false;
  }

  onDestroy(): void {
    hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', 'EntryAbility onDestroy');
  }
}
