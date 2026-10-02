/**
 * Reshapes a single aggregate SQL row (with `${dim}_avg`/`${dim}_stddev` columns, as produced
 * by each instrument's hand-written AVG/STDDEV_SAMP query) into the { count, means, stdDevs }
 * shape the frontend's AggregateSummaryComponent expects.
 */
export function toAggregateResponse(row, dimensions) {
  const means = {};
  const stdDevs = {};
  for (const dim of dimensions) {
    const avg = row[`${dim}_avg`];
    const stddev = row[`${dim}_stddev`];
    means[dim] = avg !== null && avg !== undefined ? Number(avg) : null;
    stdDevs[dim] = stddev !== null && stddev !== undefined ? Number(stddev) : null;
  }
  return { count: Number(row.count) || 0, means, stdDevs };
}
