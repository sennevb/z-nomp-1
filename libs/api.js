var redis = require('redis');
var async = require('async');

var stats = require('./stats.js');

module.exports = function(logger, portalConfig, poolConfigs){


    var _this = this;

    var portalStats = this.stats = new stats(logger, portalConfig, poolConfigs);

    this.liveStatConnections = {};

    this.handleApiRequest = function(req, res, next){
		
        switch(req.params.method){
            case 'stats':
                res.end(portalStats.statsString);
                return;
            case 'pool_stats':
                res.end(JSON.stringify(portalStats.statPoolHistory));
                return;
			/*
			case 'all_stats':
				res.end(JSON.stringify(portalStats));
				return;
				*/
			case 'worker_stats':
				if (req.url.indexOf("?")>0) {
				var url_parms = req.url.split("?");
				if (url_parms.length > 0) {
					var history = {};
					var workers = {};
					var address = url_parms[1].split(".")[0];					
					//res.end(portalStats.getWorkerStats(address));
					if (address.length > 0 && address.startsWith('t')) {
						var totalHash = parseFloat(0.0);
						var totalPaid = parseFloat(0.0);
						var networkSols = 0;
						for (var h in portalStats.statHistory) {
							for(var pool in portalStats.statHistory[h].pools) {
								for(var w in portalStats.statHistory[h].pools[pool].workers){
									if (w.startsWith(address)) {
										if (history[w] == null) {
											history[w] = [];
										}
										if (portalStats.statHistory[h].pools[pool].workers[w].hashrate) {
											history[w].push({time: portalStats.statHistory[h].time, hashrate:portalStats.statHistory[h].pools[pool].workers[w].hashrate});
										}
									}
								}
								// order check...
								//console.log(portalStats.statHistory[h].time);
							}
						}
						networkSols = portalStats.statHistory[h].pools[pool].poolStats.networkSols;
						// note, h is the last record from above loop, which is latest
						for(var pool in portalStats.stats.pools) {
						  for(var w in portalStats.stats.pools[pool].workers){
							  if (w.startsWith(address)) {
								workers[w] = portalStats.stats.pools[pool].workers[w];
								totalHash += portalStats.statHistory[h].pools[pool].workers[w].hashrate;
							  }
						  }
						}
						res.end(JSON.stringify({miner: address, totalHash: totalHash, totalPaid: totalPaid, networkSols: networkSols, "workers": workers, "history": history}));
					} else {
						res.end(JSON.stringify({result: "error"}));
					}
				} else {
					res.end(JSON.stringify({result: "error"}));
				}
				} else {
					res.end(JSON.stringify({result: "error"}));
				}
                return;
            case 'live_stats':
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
                res.write('\n');
                var uid = Math.random().toString();
                _this.liveStatConnections[uid] = res;
                req.on("close", function() {
                    delete _this.liveStatConnections[uid];
                });
                return;
            default:
                next();
        }
    };

    this.handleAdminApiRequest = function(req, res, next){
        switch(req.params.method){
            case 'pools': {
                res.end(JSON.stringify({result: poolConfigs}));
                return;
            }
            default:
                next();
        }
    };

};
