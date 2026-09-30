'use strict';

const marketStore = require('./vps-market-store');

function enabled(env) {
  const source = env || process.env;
  return source.AUTO_CUAN_MARKET_DATA_VPS === '1' ||
    String(source.AUTO_CUAN_MARKET_DATA_VPS || '').toLowerCase() === 'true';
}

function hybridizeClient(remote, env) {
  if (!enabled(env)) return remote;

  const local = marketStore.getVpsMarketStore();

  return new Proxy(remote, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return function from(table) {
          if (marketStore.MARKET_TABLES.has(String(table || ''))) {
            return local.from(String(table));
          }
          return target.from(table);
        };
      }
      if (prop === '__marketStore') return local;
      if (prop === '__marketDataVpsEnabled') return true;

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function createHybridClient(url, key, options) {
  const supabaseJs = require('@supabase/supabase-js');
  return hybridizeClient(supabaseJs.createClient(url, key, options));
}

module.exports = {
  createClient: createHybridClient,
  createHybridClient,
  hybridizeClient,
  marketDataVpsEnabled: enabled
};
