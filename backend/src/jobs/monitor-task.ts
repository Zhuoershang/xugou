import { Hono } from "hono";
import { Bindings } from "../models/db";
import { Monitor } from "../models/monitor";
import { getMonitorsToCheck, checkMonitor } from "../services";
import { shouldSendNotification, sendNotification } from "../services";
import { db } from "../config";
import {
  monitorDailyStats,
  monitorStatusHistory24h,
  monitors,
} from "../db/schema";
import { and, gte, lte } from "drizzle-orm";

const monitorTask = new Hono<{ Bindings: Bindings }>();

// 监控检查的主要函数
async function checkMonitors(c: any) {
  try {
    console.log("开始执行监控检查...");

    // 查询需要检查的监控
    const monitors = await getMonitorsToCheck();

    console.log(`找到 ${monitors?.length || 0} 个需要检查的监控`);

    if (!monitors || monitors.length === 0) {
      return { success: true, message: "没有需要检查的监控", checked: 0 };
    }

    // 检查每个监控
    const results = await Promise.all(
      monitors.map(async (monitor: Monitor) => {
        console.log(`开始检查监控: ${monitor.name} (ID: ${monitor.id})`);
        const checkResult = await checkMonitor(monitor);
        // 处理通知
        console.log(`检查完成，状态: ${checkResult.status}`);
        await handleMonitorNotification(c, monitor, checkResult);
        return checkResult;
      })
    );

    return {
      success: true,
      message: "监控检查完成",
      checked: results.length,
      results: results,
    };
  } catch (error) {
    console.error("监控检查出错:", error);
    return { success: false, message: "监控检查出错", error: String(error) };
  }
}

// 处理监控通知
async function handleMonitorNotification(
  c: any,
  monitor: Monitor,
  checkResult: any
) {
  try {
    console.log(`======= 通知检查开始 =======`);
    console.log(`监控: ${monitor.name} (ID: ${monitor.id})`);
    // console.log(
    //   `上一状态: ${checkResult.previous_status}, 当前状态: ${checkResult.status}`
    // );

    // 如果监控状态没有变化，不需要继续处理，使用 monitor.status (数据库里的最新状态) 与刚才检查到的状态 (checkResult.status)
    if (monitor.status === checkResult.status) {
      console.log(`[Monitor] ${monitor.name} 状态未变化 (${monitor.status})，忽略通知`);
      return;
    }

    // 定义当前状态和前一个状态
    const currentStatus = checkResult.status;
    const previousStatus = monitor.status || "unknown"; // 使用 monitor.status 作为前一个状态

    console.log(
      `状态已变化: ${previousStatus} -> ${currentStatus}`
    );

    // 检查是否需要发送通知
    console.log(`检查通知设置...`);
    const notificationCheck = await shouldSendNotification(
      monitor.created_by, // 修复: 传入 userId
      "monitor",
      monitor.id,
      previousStatus,
      currentStatus
    );

    console.log(
      `通知判断结果: shouldSend=${
        notificationCheck.shouldSend
      }, channels=${JSON.stringify(notificationCheck.channels)}`
    );

    if (
      !notificationCheck.shouldSend ||
      notificationCheck.channels.length === 0
    ) {
      console.log(
        `监控 ${monitor.name} (ID: ${monitor.id}) 状态变更，但不需要发送通知`
      );
      return;
    }

    console.log(
      `监控 ${monitor.name} (ID: ${monitor.id}) 状态变更，正在发送通知...`
    );
    console.log(`通知渠道: ${JSON.stringify(notificationCheck.channels)}`);

    // 信息添加红绿灯
    let errorMsg = checkResult.error || "无";
    if (currentStatus === "up") {
        errorMsg = "服务已恢复访问 🟢";
    } 
    else if (currentStatus === "down") {
        errorMsg = `${checkResult.error || "服务无法访问"} 🔴`;
    }

    // 准备通知变量
    const variables = {
      name: monitor.name,
      status: currentStatus,
      previous_status: previousStatus,
      time: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      url: monitor.url,
      response_time: `${checkResult.responseTime}ms`,
      status_code: checkResult.statusCode
        ? checkResult.statusCode.toString()
        : "无",
      expected_status: monitor.expected_status.toString(),
      error: errorMsg,
      details: `URL: ${monitor.url}\n响应时间: ${
        checkResult.responseTime
      }ms\n状态码: ${checkResult.statusCode || "无"}\n错误信息: ${
        checkResult.error || "无"
      }`,
    };

    console.log(`通知变量: ${JSON.stringify(variables)}`);

    // 发送通知
    console.log(`开始发送通知...`);
    const notificationResult = await sendNotification(
      "monitor",
      monitor.id,
      variables,
      notificationCheck.channels,
      monitor.created_by // 修复: 传入 userId
    );

    console.log(`通知发送结果: ${JSON.stringify(notificationResult)}`);

    if (notificationResult.success) {
      console.log(`监控 ${monitor.name} (ID: ${monitor.id}) 通知发送成功`);
    } else {
      console.error(`监控 ${monitor.name} (ID: ${monitor.id}) 通知发送失败`);
    }
    console.log(`======= 通知检查结束 =======`);
  } catch (error) {
    console.error(
      `处理监控通知时出错 (${monitor.name}, ID: ${monitor.id}):`,
      error
    );
  }
}

// 从24小时热表生成每日监控统计数据的函数
async function generateDailyStats(c: any) {
  try {
    console.log("开始从24小时热表生成每日监控统计数据...");

    // 获取前一天的日期 (YYYY-MM-DD 格式)
    const yesterday = new Date();// 获取时间设定为UTC   X日
    // 获取当前UTC 时间的时分数
    const hour = now.getUTCHours(); 
    const minute = now.getUTCMinutes();
    // 我们设定，在北京时间0点之后，整理前一天的数据。
    // 那么北京时间  X+1日 0点时刻，UTC时间为X日16点。所以：
    // 如果在UTC    X日16点前整理数据，此时北京时间与UTC同在X日，则整理X-1日数据。
    // 如果在UTC    X日16点后整理数据，此时北京时间已变为X+1日，则整理X日的数据。
    if(hour<16){
      yesterday.setDate(yesterday.getDate() - 1); // 修正：获取前一天的日期
      // 有点绕，也就是说 UTC时间的16点之后，已经是北京时间的第二天的。所以此时段  UTC时间的当天日期本身就是北京时间的昨天日期。不用再做-1
      // 原开发者设置的整理数据触发时间为每日0点05分，这个时间段0<16 所以需要-1。 而我设置时间为16:30，因此判断一下就不用-1了。
    }
    
    const dateStr = yesterday.toISOString().split("T")[0];

    console.log(`正在处理日期 ${dateStr} 的数据`);

    // 时间范围
    const startTime = `${dateStr}T00:00:00.000Z`;
    const endTime = `${dateStr}T23:59:59.999Z`;

    // 一次性获取所有监控
    const monitorsResult = await db.select().from(monitors);

    if (!monitorsResult || monitorsResult.length === 0) {
      console.log("没有找到监控");
      return { success: true, message: "没有监控", processed: 0 };
    }

    const allMonitors = monitorsResult as Monitor[];
    console.log(`找到 ${allMonitors.length} 个监控`);

    // 创建监控ID列表
    const monitorIds = allMonitors.map((m: any) => m.id);

    // 从24小时热表获取监控历史记录
    console.log(
      `从24小时热表查询所有监控在 ${startTime} 至 ${endTime} 的历史记录`
    );

    const historyResult = await db
      .select()
      .from(monitorStatusHistory24h)
      .where(
        and(
          gte(monitorStatusHistory24h.timestamp, startTime),
          lte(monitorStatusHistory24h.timestamp, endTime)
        )
      );

    if (!historyResult || historyResult.length === 0) {
      console.log(`在 ${dateStr} 没有找到任何监控历史记录`);
      return { success: true, message: "没有历史记录", processed: 0 };
    }

    console.log(`找到 ${historyResult.length} 条历史记录`);

    // 按监控ID分组处理数据
    const statsMap = new Map();

    // 初始化每个监控的统计数据结构
    for (const monitorId of monitorIds) {
      statsMap.set(monitorId, {
        monitorId,
        totalChecks: 0,
        upChecks: 0,
        downChecks: 0,
        responseTimes: [],
        avgResponseTime: 0,
        minResponseTime: 0,
        maxResponseTime: 0,
        availability: 0,
      });
    }

    // 处理所有历史记录
    for (const record of historyResult) {
      const monitorId = record.monitor_id;

      if (!statsMap.has(monitorId)) continue;

      const stats = statsMap.get(monitorId);
      stats.totalChecks++;

      if (record.status === "up") {
        stats.upChecks++;
      } else if (record.status === "down") {
        stats.downChecks++;
      }

      if (record.response_time != null && record.response_time > 0) {
        stats.responseTimes.push(record.response_time);
      }
    }

    // 处理每个监控的响应时间统计和可用率计算
    for (const [monitorId, stats] of statsMap.entries()) {
      if (stats.totalChecks === 0) continue;

      if (stats.responseTimes.length > 0) {
        stats.avgResponseTime =
          stats.responseTimes.reduce(
            (sum: number, time: number) => sum + time,
            0
          ) / stats.responseTimes.length;
        stats.minResponseTime = Math.min(...stats.responseTimes);
        stats.maxResponseTime = Math.max(...stats.responseTimes);
      } else {
        // 改进：处理 responseTimes 为空的情况
        stats.avgResponseTime = 0;
        stats.minResponseTime = 0;
        stats.maxResponseTime = 0;
      }

      stats.availability =
        stats.totalChecks > 0 ? (stats.upChecks / stats.totalChecks) * 100 : 0;

      delete stats.responseTimes;
    }

    // 将统计数据写入数据库
    const now = new Date().toISOString();
    let processed = 0;

    for (const [monitorId, stats] of statsMap.entries()) {
      if (stats.totalChecks === 0) continue;

      const monitor = allMonitors.find((m: any) => m.id === monitorId);
      const monitorName = monitor ? monitor.name : `ID: ${monitorId}`;

      try {
        console.log(
          `监控 ${monitorName} (ID: ${monitorId}) 数据: 总检查=${
            stats.totalChecks
          }, 正常=${stats.upChecks}, 故障=${
            stats.downChecks
          }, 可用率=${stats.availability.toFixed(2)}%`
        );

        await db.insert(monitorDailyStats).values({
          monitor_id: monitorId,
          date: dateStr,
          total_checks: stats.totalChecks,
          up_checks: stats.upChecks,
          down_checks: stats.downChecks,
          avg_response_time: stats.avgResponseTime,
          min_response_time: stats.minResponseTime,
          max_response_time: stats.maxResponseTime,
          availability: stats.availability,
          created_at: now,
        });

        processed++;
        console.log(`成功更新监控 ID ${monitorId} 的每日统计数据`);
      } catch (error) {
        console.error(`更新监控 ID ${monitorId} 的每日统计数据时出错:`, error);
      }
    }

    console.log(`每日统计数据生成完成，成功处理了 ${processed} 个监控`);

    // 从 24h 表中删除已处理的数据
    console.log(`开始从24小时热表删除已处理的数据`);
    await db
      .delete(monitorStatusHistory24h)
      .where(
        and(
          gte(monitorStatusHistory24h.timestamp, startTime),
          lte(monitorStatusHistory24h.timestamp, endTime)
        )
      );
    console.log(`从24小时热表删除已处理的数据完成`);

    return {
      success: true,
      message: "每日统计数据生成完成",
      processed: processed,
      date: dateStr,
    };
  } catch (error) {
    console.error("生成每日统计数据时出错:", error);
    return {
      success: false,
      message: "生成每日统计数据时出错",
      error: String(error),
    };
  }
}
// 在 Cloudflare Workers 中设置定时触发器
export default {
  async scheduled(event: any, env: any, ctx: any) {
    const c = { env };

    // 默认执行监控检查任务
    let result: any = await checkMonitors(c);

    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    if (hour == 16 && minute == 30) {
      // UTC时间即世界协调时间，北京时间属于中国标准时间，比UTC时间快8小时，即北京时间等于UTC时间加上8小时。
      // UTC 16点，正好是北京时间 下一天的0点。 因此在北京时间0点之后开始统计前一天的记录，则触发时钟应该在UTC前一天的16点之后执行。
      // 此处选择在UTC16:30（也即北京时间0:30） 生成生成每日（前一天）监控统计数据 统计范围为前一天的0点至23点59
      const statsResult = await generateDailyStats(c);
      console.log("生成每日监控统计测试");
      if (statsResult.error) {
        console.error("生成每日监控统计数据时出错:", statsResult.error);
      }
    }

    return result;
  },
  fetch: monitorTask.fetch,
};
