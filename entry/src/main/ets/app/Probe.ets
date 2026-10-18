import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

/**
 * HTTP 探活：Host 就绪后先用 HEAD 确认 127.0.0.1 可达，再 loadUrl。
 *
 * 只判「能否连上」——状态码 401/404 也算可达（说明监听在，只是没带凭据）。
 */
export class Probe {
  /**
   * 重试等待目标可达。
   * @param url - 目标 URL（通常为 http://127.0.0.1:<port>/）
   * @param retries - 最大尝试次数
   * @param intervalMs - 每次间隔
   * @returns 可达为 true；次数耗尽为 false
   */
  static async waitFor(url: string, retries: number, intervalMs: number): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const reachable: boolean = await Probe.head(url);
      if (reachable) {
        return true;
      }
      if (i < retries - 1) {
        await Probe.sleep(intervalMs);
      }
    }
    return false;
  }

  private static head(url: string): Promise<boolean> {
    let request: http.HttpRequest | null = null;
    try {
      request = http.createHttp();
    } catch (error) {
      return Promise.resolve(false);
    }
    const current: http.HttpRequest = request;
    return new Promise<boolean>((resolve: (value: boolean) => void) => {
      try {
        current.request(
          url,
          {
            method: http.RequestMethod.HEAD,
            connectTimeout: 2000,
            readTimeout: 2000,
            expectDataType: http.HttpDataType.STRING
          },
          (err: BusinessError, _data: http.HttpResponse) => {
            try {
              current.destroy();
            } catch (error) {
              // destroy 失败不影响判定。
            }
            // err 为空即代表请求完成（含 4xx/5xx）：监听存在，凭据交给页面自己的 cookie。
            resolve(err === undefined || err === null);
          }
        );
      } catch (error) {
        // 同步抛出：必须销毁句柄，避免 HttpRequest 泄漏。
        try {
          current.destroy();
        } catch (destroyError) {
          // 同上。
        }
        resolve(false);
      }
    });
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }
}
