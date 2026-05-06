'use strict';

/**
 * 分享卡生成
 *
 * 在离屏 Canvas（id="share-canvas"）上绘制分享卡片，
 * 导出为临时文件路径后可调用 wx.saveImageToPhotosAlbum。
 *
 * 卡片规格：375 × 560 CSS px，DPR=2 → 物理 750 × 1120 px
 * 适配朋友圈（正方形裁剪区内完整显示）和小红书（3:4 竖版）。
 */

const { moodColor } = require('./mood-color');

// 每个心情分值对应的卡片标题
const CARD_TITLES = [
  '今天很难。',
  '今天很难。',
  '在撑着。',
  '在撑着。',
  '及格了。',
  '还不错。',
  '还不错。',
  '今天你在发光。',
  '今天你在发光。',
  '今天你在发光。',
];

/**
 * 生成分享卡片并返回临时文件路径。
 *
 * @param {Object} page    Page 实例（wx.createSelectorQuery 需要）
 * @param {Object} data
 *   @param {number}  data.mood         1–10
 *   @param {string}  data.city         用户所在城市
 *   @param {number}  data.cityAvg      城市平均心情（可为 null）
 *   @param {number}  data.percentile   百分位 0–100（可为 null）
 *   @param {number}  data.streak       连续天数
 *   @param {number}  data.totalCount   全国今日提交总数
 * @returns {Promise<string>}  临时文件路径，失败时返回 ''
 */
function generateShareCard(page, data) {
  const {
    mood = 5,
    city = '',
    cityAvg = null,
    percentile = null,
    streak = 0,
    totalCount = 0,
  } = data;

  const color = moodColor(mood);

  return new Promise(resolve => {
    wx.createSelectorQuery()
      .in(page)
      .select('#share-canvas')
      .fields({ node: true })
      .exec(res => {
        if (!res || !res[0] || !res[0].node) { resolve(''); return; }

        const canvas = res[0].node;
        const W = 375, H = 560, DPR = 2;
        canvas.width  = W * DPR;
        canvas.height = H * DPR;

        const ctx = canvas.getContext('2d');
        ctx.scale(DPR, DPR);

        // ── 背景 ────────────────────────────────────────────────────────────
        ctx.fillStyle = '#12121f';
        ctx.fillRect(0, 0, W, H);

        // 情绪色晕（顶部中心）
        const glow = ctx.createRadialGradient(W / 2, 130, 0, W / 2, 130, 210);
        glow.addColorStop(0, color + '44');
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);

        // ── 应用名 + 日期（顶部）────────────────────────────────────────────
        const now = new Date();
        const dateStr = `${now.getFullYear()}.${p2(now.getMonth()+1)}.${p2(now.getDate())}`;
        ctx.fillStyle = 'rgba(255,255,255,0.40)';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`🌏  情绪地图  ·  ${dateStr}`, W / 2, 46);

        // ── 大分值 ──────────────────────────────────────────────────────────
        ctx.fillStyle = color;
        ctx.font = `bold 104px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(String(mood), W / 2, 180);

        // ── 进度条 ──────────────────────────────────────────────────────────
        const BW = 220, BH = 8, BX = (W - BW) / 2, BY = 200;
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        pill(ctx, BX, BY, BW, BH, 4); ctx.fill();
        ctx.fillStyle = color;
        pill(ctx, BX, BY, BW * mood / 10, BH, 4); ctx.fill();

        // ── 心情标题 ─────────────────────────────────────────────────────────
        ctx.fillStyle = 'rgba(255,255,255,0.90)';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(CARD_TITLES[mood - 1], W / 2, 242);

        // ── 分隔线 ──────────────────────────────────────────────────────────
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(36, 266, W - 72, 1);

        // ── 统计行 ──────────────────────────────────────────────────────────
        const rows = [];
        if (city && cityAvg !== null) {
          const rel = mood > cityAvg ? '比城市更开心 😊'
                    : mood < cityAvg ? '低于城市均值'
                    :                  '和城市持平';
          rows.push(`📍  ${city} 今日 ${cityAvg}，我${rel}`);
        }
        if (percentile !== null && percentile >= 40) {
          rows.push(`🏅  超过了周围 ${percentile}% 的人`);
        }
        if (streak >= 2) {
          rows.push(`🔥  连续记录第 ${streak} 天`);
        }
        if (totalCount > 0) {
          rows.push(`🌏  今天全国 ${totalCount.toLocaleString()} 人在这里`);
        }

        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.font = '15px sans-serif';
        ctx.textAlign = 'left';
        rows.forEach((text, i) => {
          ctx.fillText(text, 40, 300 + i * 46);
        });

        // ── 底部分隔线 ───────────────────────────────────────────────────────
        const divY = 300 + rows.length * 46 + 20;
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(36, divY, W - 72, 1);

        // ── 底部隐私说明 ─────────────────────────────────────────────────────
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('匿名 · 无需注册 · 位置已模糊到 ~1 公里', W / 2, H - 38);
        ctx.fillText('扫码体验情绪地图', W / 2, H - 18);

        wx.canvasToTempFilePath({
          canvas,
          success: r => resolve(r.tempFilePath),
          fail:    () => resolve(''),
        }, page);
      });
  });
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 绘制圆角矩形路径（不 fill/stroke，由调用方决定）。 */
function pill(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

/** 数字补零到两位。 */
function p2(n) { return String(n).padStart(2, '0'); }

module.exports = { generateShareCard };
