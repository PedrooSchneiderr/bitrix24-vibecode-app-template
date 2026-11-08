'use strict';

const { read } = require('./vibeClient');

/**
 * Funil de negócios de uma pipeline.
 * Etapas vêm de /v1/statuses (nunca hardcoded); contagens de /v1/deals/aggregate.
 * Etapas sem negócio aparecem com zero; "ganho" = semantics "S".
 */
async function getFunnel({ categoryId = 0, session }) {
  const entityId = Number(categoryId) === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${Number(categoryId)}`;

  const [statuses, aggregate] = await Promise.all([
    read('POST', '/statuses/search', {
      session,
      body: { filter: { entityId }, order: { sort: 'asc' }, limit: 100 },
    }),
    read('POST', '/deals/aggregate', {
      session,
      body: {
        filter: { categoryId: Number(categoryId) },
        groupBy: ['stageId'],
        metrics: [{ fn: 'count' }, { fn: 'sum', field: 'opportunity' }],
      },
    }),
  ]);

  const byStage = new Map();
  for (const row of toArray(aggregate)) {
    byStage.set(row.stageId, { count: Number(row.count) || 0, sum: Number(row.sum_opportunity ?? row.sum) || 0 });
  }

  const stages = toArray(statuses).map((s) => {
    const agg = byStage.get(s.statusId) || { count: 0, sum: 0 };
    return {
      id: s.statusId,
      name: s.name,
      color: s.color || null,
      semantics: s.semantics || null, // "S" ganho, "F" perdido, vazio = em andamento
      count: agg.count,
      sum: agg.sum,
    };
  });

  const total = stages.reduce((n, s) => n + s.count, 0);
  const won = stages.filter((s) => s.semantics === 'S').reduce((n, s) => n + s.count, 0);

  return { categoryId: Number(categoryId), stages, total, won, winRate: total ? won / total : 0 };
}

function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

module.exports = { getFunnel };
