'use strict';

/**
 * 本地情绪历史管理
 *
 * 数据结构（存入 wx.setStorageSync）：
 *   mood_history: Array<{ mood, city, ts, day }>  最多 90 条
 *   last_city:    string   上次提交的城市（供排行榜高亮）
 *
 * 所有操作都在本地完成，无需后端，无需登录。
 */

const STORAGE_KEY = 'mood_history';
const MAX_RECORDS = 90;

// 连续打卡里程碑文案
const MILESTONES = {
  1:   '第一次诚实记录，挺好的。',
  3:   '连续 3 天了。你开始认真对待自己的感受。',
  7:   '7天打卡。你比 95% 的人更了解自己的情绪。',
  14:  '两周了。情绪是有规律的，你在发现它。',
  30:  '一个月，30 次诚实。这很难得。',
  100: '100 天。你已经是 1% 的人了。',
};

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 保存一条心情记录，返回最新 streak 和里程碑文案。
 * @param {number} mood   1–10
 * @param {string} city   城市名，来自 submitMood 返回值
 * @returns {{ streak: number, milestoneMsg: string }}
 */
function save(mood, city) {
  const records = getAll();
  const ts  = Math.floor(Date.now() / 1000);
  const day = dayKey(Date.now());

  // 同一天已经有记录时仍然保存（用于追踪一天内多次变化）
  records.unshift({ mood, city: city || '其他', ts, day });
  if (records.length > MAX_RECORDS) records.splice(MAX_RECORDS);

  try { wx.setStorageSync(STORAGE_KEY, records); } catch {}
  try { wx.setStorageSync('last_city', city || ''); } catch {}

  const streak = calcStreak(records);
  return {
    streak,
    milestoneMsg: MILESTONES[streak] || (streak > 1 ? `连续记录第 ${streak} 天` : ''),
  };
}

/** 返回所有本地记录（最新在前）。 */
function getAll() {
  try { return wx.getStorageSync(STORAGE_KEY) || []; }
  catch { return []; }
}

/** 返回当前连续打卡天数。 */
function getStreak() {
  return calcStreak(getAll());
}

/** 返回上次提交的城市名，用于排行榜高亮。 */
function getLastCity() {
  try { return wx.getStorageSync('last_city') || ''; }
  catch { return ''; }
}

/**
 * 返回最近 7 天的统计摘要。
 * @returns {{ count, avg, trend } | null}
 */
function getWeekSummary() {
  const records = getAll();
  const since   = Math.floor(Date.now() / 1000) - 7 * 86400;
  const week    = records.filter(r => r.ts >= since);

  if (week.length === 0) return null;

  const avg = week.reduce((s, r) => s + r.mood, 0) / week.length;

  // 对比上上周
  const since2w  = since - 7 * 86400;
  const prevWeek = records.filter(r => r.ts >= since2w && r.ts < since);
  let trend = null;
  if (prevWeek.length > 0) {
    const prevAvg = prevWeek.reduce((s, r) => s + r.mood, 0) / prevWeek.length;
    trend = Math.round((avg - prevAvg) * 10) / 10;
  }

  return {
    count: week.length,
    avg:   Math.round(avg * 10) / 10,
    trend,
  };
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

/** 生成 "YYYY-M-D" 格式的日期键（按本地时间）。 */
function dayKey(tsMs) {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * 计算连续打卡天数。
 * 逻辑：若今天已有记录，从今天往前数；若今天无记录，从昨天往前数。
 */
function calcStreak(records) {
  if (!records || records.length === 0) return 0;

  const days = new Set(records.map(r => r.day));
  const todayKey = dayKey(Date.now());

  let streak = 0;
  const cursor = new Date();

  // 若今天没有记录，从昨天开始
  if (!days.has(todayKey)) cursor.setDate(cursor.getDate() - 1);

  for (let i = 0; i < 366; i++) {
    if (days.has(dayKey(cursor.getTime()))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

module.exports = { save, getAll, getStreak, getLastCity, getWeekSummary };
