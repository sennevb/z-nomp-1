var zlib = require('zlib');

var redis = require('redis');
var async = require('async');


var os = require('os');

var algos = require('stratum-pool/lib/algoProperties.js');

function balanceRound(number) {
	return parseFloat((Math.round(number * 100000000) / 100000000).toFixed(8));
}

module.exports = function(logger, portalConfig, poolConfigs){

    var _this = this;

    var logSystem = 'Stats';

    var redisClients = [];
    var redisStats;

    this.statHistory = [];
    this.statPoolHistory = [];

    this.stats = {};
    this.statsString = '';

    setupStatsRedis();
    gatherStatHistory();

    var canDoStats = true;

    Object.keys(poolConfigs).forEach(function(coin){

        if (!canDoStats) return;

        var poolConfig = poolConfigs[coin];

        var redisConfig = poolConfig.redis;

        for (var i = 0; i < redisClients.length; i++){
            var client = redisClients[i];
            if (client.client.port === redisConfig.port && client.client.host === redisConfig.host){
                client.coins.push(coin);
                return;
            }
        }
        redisClients.push({
            coins: [coin],
            client: redis.createClient(redisConfig.port, redisConfig.host)
        });
    });


    function setupStatsRedis(){
        redisStats = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
        redisStats.on('error', function(err){
            logger.error(logSystem, 'Historics', 'Redis for stats had an error ' + JSON.stringify(err));
        });
    }

    function gatherStatHistory(){

        var retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0).toString();

        redisStats.zrangebyscore(['statHistory', retentionTime, '+inf'], function(err, replies){
            if (err) {
                logger.error(logSystem, 'Historics', 'Error when trying to grab historical stats ' + JSON.stringify(err));
                return;
            }
            for (var i = 0; i < replies.length; i++){
                _this.statHistory.push(JSON.parse(replies[i]));
            }
            _this.statHistory = _this.statHistory.sort(function(a, b){
                return a.time - b.time;
            });
            _this.statHistory.forEach(function(stats){
                addStatPoolHistory(stats);
            });
        });
    }

	function getWorkerStats(address) {
		address = address.split(".")[0];
		if (address.length > 0 && address.startsWith('t')) {
			for (var h in statHistory) {
				for(var pool in statHistory[h].pools) {
					
					statHistory[h].pools[pool].workers.sort(sortWorkersByHashrate);

					for(var w in statHistory[h].pools[pool].workers){
						if (w.startsWith(address)) {
							if (history[w] == null) {
								history[w] = [];
							}
							if (workers[w] == null && stats.pools[pool].workers[w] != null) {
								workers[w] = stats.pools[pool].workers[w];
							}
							if (statHistory[h].pools[pool].workers[w].hashrate) {
								history[w].push({time: statHistory[h].time, hashrate:statHistory[h].pools[pool].workers[w].hashrate});
							}
						}
					}
				}
			}
			return JSON.stringify({"workers": workers, "history": history});
		}
		return null;
	}
	
    function addStatPoolHistory(stats){
        var data = {
            time: stats.time,
            pools: {}
        };
        for (var pool in stats.pools){
            data.pools[pool] = {
                hashrate: stats.pools[pool].hashrate,
                workerCount: stats.pools[pool].workerCount,
                blocks: stats.pools[pool].blocks
            }
        }
        _this.statPoolHistory.push(data);
    }

    this.getCoins = function(cback){
        _this.stats.coins = redisClients[0].coins;
        cback();
    };
    this.getPayout = function(address, cback){
        async.waterfall([
            function(callback){
                _this.getBalanceByAddress(address, function(){
                    callback(null, 'test');
                });
            }
        ], function(err, total){
            cback(balanceRound(total).toFixed(8));
        });
    };

    this.getBalanceByAddress = function(address, cback){

	    var a = address.split(".")[0];
		
        var client = redisClients[0].client,
            coins = redisClients[0].coins,
            balances = [];
            payouts = [];
		
		async.each(_this.stats.pools, function(pool, pcb) {
			var coin = String(_this.stats.pools[pool.name].name);
			async.each(_this.stats.pools[pool.name].workers, function(w, cb) {
				if (String(w.name).startsWith(a)) {
					client.hget(coin + ':balances', w.name, function(error, result){
						if (error){
							callback("There was an error getting balances");
							return;
						}
						
						if(result === null) {
							result = 0;
						}else{
							result = result;
						}
						
						client.hget(coin + ':payouts', w.name, function(error, paid){
							if (error){
								callback("There was an error getting balances");
								return;
							}
							if(paid === null) {
								paid = 0;
							}else{
								paid = balanceRound(paid);
							}
							balances.push({
								worker:w.name,
								balance:balanceRound(result),
								paid:balanceRound(paid)
							});
							cb();
						});
					});
				} else {
					cb();
				}
			}, function(err) {
				if (err) {
					callback("There was an error getting balances");
					return;
				}
				pcb();
			});
		}, function(err) {
			if (err) {
				callback("There was an error getting balances");
				return;
			}
			
			_this.stats.balances = balances;
			_this.stats.address = address;
			
			cback();
		});
	};

    this.getGlobalStats = function(callback){

        var statGatherTime = Date.now() / 1000 | 0;

        var allCoinStats = {};

        async.each(redisClients, function(client, callback){
            var windowTime = (((Date.now() / 1000) - portalConfig.website.stats.hashrateWindow) | 0).toString();
            var redisCommands = [];


            var redisCommandTemplates = [
                ['zremrangebyscore', ':hashrate', '-inf', '(' + windowTime],
                ['zrangebyscore', ':hashrate', windowTime, '+inf'],
                ['hgetall', ':stats'],
                ['scard', ':blocksPending'],
                ['scard', ':blocksConfirmed'],
                ['scard', ':blocksKicked'],
				['smembers', ':blocksPending'],
				['smembers', ':blocksConfirmed'],
				['hgetall', ':shares:roundCurrent']
            ];

            var commandsPerCoin = redisCommandTemplates.length;

            client.coins.map(function(coin){
                redisCommandTemplates.map(function(t){
                    var clonedTemplates = t.slice(0);
                    clonedTemplates[1] = coin + clonedTemplates[1];
                    redisCommands.push(clonedTemplates);
                });
            });

            client.client.multi(redisCommands).exec(function(err, replies){
                if (err){
                    logger.error(logSystem, 'Global', 'error with getting global stats ' + JSON.stringify(err));
                    callback(err);
                }
                else{
                    for(var i = 0; i < replies.length; i += commandsPerCoin){
                        var coinName = client.coins[i / commandsPerCoin | 0];
                        var coinStats = {
                            name: coinName,
                            symbol: poolConfigs[coinName].coin.symbol.toUpperCase(),
                            algorithm: poolConfigs[coinName].coin.algorithm,
                            hashrates: replies[i + 1],
                            poolStats: {
                                validShares: replies[i + 2] ? (replies[i + 2].validShares || 0) : 0,
                                validBlocks: replies[i + 2] ? (replies[i + 2].validBlocks || 0) : 0,
                                invalidShares: replies[i + 2] ? (replies[i + 2].invalidShares || 0) : 0,
                                totalPaid: replies[i + 2] ? (replies[i + 2].totalPaid || 0) : 0,
								networkBlocks: replies[i + 2] ? (replies[i + 2].networkBlocks || 0) : 0,
								networkSols: replies[i + 2] ? (replies[i + 2].networkSols || 0) : 0, 
								networkSolsString: getReadableNetworkHashRateString(replies[i + 2] ? (replies[i + 2].networkSols || 0) : 0), 
								networkDiff: replies[i + 2] ? (replies[i + 2].networkDiff || 0) : 0,
								networkConnections: replies[i + 2] ? (replies[i + 2].networkConnections || 0) : 0
                            },
                            blocks: {
                                pending: replies[i + 3],
                                confirmed: replies[i + 4],
                                orphaned: replies[i + 5]
                            },
							pending: {
								blocks: replies[i + 6]
							},
							confirmed: {
								blocks: replies[i + 7]
							},
							currentRoundShares: replies[i + 8]
                        };
                        allCoinStats[coinStats.name] = (coinStats);
                    }
                    callback();
                }
            });
        }, function(err){
            if (err){
                logger.error(logSystem, 'Global', 'error getting all stats' + JSON.stringify(err));
                callback();
                return;
            }

            var portalStats = {
                time: statGatherTime,
                global:{
                    workers: 0,
                    hashrate: 0
                },
                algos: {},
                pools: allCoinStats
            };

            Object.keys(allCoinStats).forEach(function(coin){
                var coinStats = allCoinStats[coin];
                coinStats.workers = {};
				coinStats.miners = {};
                coinStats.shares = 0;
                coinStats.hashrates.forEach(function(ins){
                    var parts = ins.split(':');
                    var workerShares = parseFloat(parts[0]);
					var miner = parts[1].split('.')[0];
                    var worker = parts[1];
					var diff = Math.round(parts[0] * 8192);
                    if (workerShares > 0) {
                        coinStats.shares += workerShares;
						// build worker stats
                        if (worker in coinStats.workers) {
                            coinStats.workers[worker].shares += workerShares;
							coinStats.workers[worker].diff = diff;
                        } else {
                            coinStats.workers[worker] = {
								name: worker,
								diff: diff,
                                shares: workerShares,
                                invalidshares: 0,
								currRoundShares: 0,
								hashrate: null,
                                hashrateString: null,
								luckDays: null
                            };
						}
						// build miner stats
						if (miner in coinStats.miners) {
							coinStats.miners[miner].shares += workerShares;
						} else {
							coinStats.miners[miner] = {
								name: miner,
								shares: workerShares,
								invalidshares: 0,
								currRoundShares: 0,
								hashrate: null,
								hashrateString: null,
								luckDays: null
							};
						}
                    }
                    else {
						// build worker stats
                        if (worker in coinStats.workers) {
                            coinStats.workers[worker].invalidshares -= workerShares; // workerShares is negative number!
							coinStats.workers[worker].diff = diff;
                        } else {
                            coinStats.workers[worker] = {
                                shares: 0,
                                invalidshares: -workerShares,
								currRoundShares: 0,
                                hashrateString: null,
                            };
						}
						// build miner stats
						if (miner in coinStats.miners) {
							coinStats.miners[miner].invalidshares -= workerShares; // workerShares is negative number!
						} else {
							coinStats.miners[miner] = {
								shares: 0,
								currRoundShares: 0,
								invalidshares: -workerShares,
								hashrateString: null,
							};
						}
                    }
                });

                var shareMultiplier = Math.pow(2, 32) / algos[coinStats.algorithm].multiplier;
                coinStats.hashrate = shareMultiplier * coinStats.shares / portalConfig.website.stats.hashrateWindow;
                coinStats.hashrateString = _this.getReadableHashRateString(coinStats.hashrate);
				var _networkHashRate = parseFloat(coinStats.poolStats.networkSols) * 1.1;
				var _myHashRate = (coinStats.hashrate / 1000000) * 2;
				coinStats.luckDays =  ((_networkHashRate / _myHashRate * 150) / (24 * 60 * 60)).toFixed(3);
				coinStats.minerCount = Object.keys(coinStats.miners).length;
                coinStats.workerCount = Object.keys(coinStats.workers).length;
                portalStats.global.workers += coinStats.workerCount;

                /* algorithm specific global stats */
                var algo = coinStats.algorithm;
                if (!portalStats.algos.hasOwnProperty(algo)){
                    portalStats.algos[algo] = {
                        workers: 0,
                        hashrate: 0,
                        hashrateString: null
                    };
                }
                portalStats.algos[algo].hashrate += coinStats.hashrate;
                portalStats.algos[algo].workers += Object.keys(coinStats.workers).length;

				for (var worker in coinStats.currentRoundShares) {
						var miner = worker.split(".")[0];
						if (miner in coinStats.miners) {
							coinStats.miners[miner].currRoundShares += coinStats.currentRoundShares[worker];
						}
						if (worker in coinStats.workers) {
							coinStats.workers[worker].currRoundShares += coinStats.currentRoundShares[worker];
						}
				}
				
                for (var worker in coinStats.workers) {
					var _workerRate = shareMultiplier * coinStats.workers[worker].shares / portalConfig.website.stats.hashrateWindow;
					var _wHashRate = (_workerRate / 1000000) * 2;
					coinStats.workers[worker].luckDays = ((_networkHashRate / _wHashRate * 150) / (24 * 60 * 60)).toFixed(3);
					coinStats.workers[worker].hashrate = _workerRate;
					coinStats.workers[worker].hashrateString = _this.getReadableHashRateString(_workerRate);
                }
				for (var miner in coinStats.miners) {
					var _workerRate = shareMultiplier * coinStats.miners[miner].shares / portalConfig.website.stats.hashrateWindow;
					var _wHashRate = (_workerRate / 1000000) * 2;
					coinStats.miners[miner].luckDays = ((_networkHashRate / _wHashRate * 150) / (24 * 60 * 60)).toFixed(3);
					coinStats.miners[miner].hashrate = _workerRate;
					coinStats.miners[miner].hashrateString = _this.getReadableHashRateString(_workerRate);
                }
				
                delete coinStats.hashrates;
                delete coinStats.shares;
            });

            Object.keys(portalStats.algos).forEach(function(algo){
                var algoStats = portalStats.algos[algo];
                algoStats.hashrateString = _this.getReadableHashRateString(algoStats.hashrate);
            });
			
			// TODO, create stats object and copy elements from portalStats we want to display...
			var showStats = portalStats;
			
            _this.stats = portalStats;
            _this.statsString = JSON.stringify(portalStats);

            _this.statHistory.push(portalStats);
            addStatPoolHistory(portalStats);

            var retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0);

            for (var i = 0; i < _this.statHistory.length; i++){
                if (retentionTime < _this.statHistory[i].time){
                    if (i > 0) {
                        _this.statHistory = _this.statHistory.slice(i);
                        _this.statPoolHistory = _this.statPoolHistory.slice(i);
                    }
                    break;
                }
            }

            redisStats.multi([
                ['zadd', 'statHistory', statGatherTime, _this.statsString],
                ['zremrangebyscore', 'statHistory', '-inf', '(' + retentionTime]
            ]).exec(function(err, replies){
                if (err)
                    logger.error(logSystem, 'Historics', 'Error adding stats to historics ' + JSON.stringify(err));
            });
            callback();
        });

    };

	function sortBlocks(a, b) {
		if (a.hashrate === b.hashrate) {
			return 0;
		}
		else {
			return (a.hashrate < b.hashrate) ? -1 : 1;
		}
	}
	
	function sortWorkersByHashrate(a, b) {
		if (a.hashrate === b.hashrate) {
			return 0;
		}
		else {
			return (a.hashrate < b.hashrate) ? -1 : 1;
		}
	}

    this.getReadableHashRateString = function(hashrate){
        if (hashrate < 1000000)
            return '0 Sol';
        var byteUnits = [ ' Sol/s', ' KSol/s', ' MSol/s', ' GSol/s', ' TSol/s', ' PSol/s' ];
        hashrate = (hashrate * 2);
        var i = Math.floor((Math.log(hashrate/1000) / Math.log(1000)) - 1);
        hashrate = (hashrate/1000) / Math.pow(1000, i + 1);
        return hashrate.toFixed(2) + byteUnits[i];
    };
	
	function getReadableNetworkHashRateString(hashrate) {
		hashrate = (hashrate * 1000000);
		if (hashrate < 1000000)
			return '0 Sol';
		var byteUnits = [ ' Sol/s', ' KSol/s', ' MSol/s', ' GSol/s', ' TSol/s', ' PSol/s' ];
		var i = Math.floor((Math.log(hashrate/1000) / Math.log(1000)) - 1);
		hashrate = (hashrate/1000) / Math.pow(1000, i + 1);
		return hashrate.toFixed(2) + byteUnits[i];
	}
};
