var fs = require('fs');

var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');


module.exports = function(logger){

    var poolConfigs = JSON.parse(process.env.pools);

    var enabledPools = [];

    Object.keys(poolConfigs).forEach(function(coin) {
        var poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing &&
            poolOptions.paymentProcessing.enabled)
            enabledPools.push(coin);
    });

    async.filter(enabledPools, function(coin, callback){
        SetupForPool(logger, poolConfigs[coin], function(setupResults){
            callback(null, setupResults);
        });
    }, function(err, results){
        results.forEach(function(coin){

            var poolOptions = poolConfigs[coin];
            var processingConfig = poolOptions.paymentProcessing;
            var logSystem = 'Payments';
            var logComponent = coin;

            logger.debug(logSystem, logComponent, 'Payment processing setup to run every '
                + processingConfig.paymentInterval + ' second(s) with daemon ('
                + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
                + ') and redis (' + poolOptions.redis.host + ':' + poolOptions.redis.port + ')');

        });
    });
};

var _coin = '';

function SetupForPool(logger, poolOptions, setupFinished){


    var coin = poolOptions.coin.name;
    var processingConfig = poolOptions.paymentProcessing;

    var logSystem = 'Payments';
    var logComponent = coin;
	_coin = coin;
	
    var daemon = new Stratum.daemon.interface([processingConfig.daemon], function(severity, message){
        logger[severity](logSystem, logComponent, message);
    });
    var redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);

    var magnitude;
    var minPaymentSatoshis;
    var coinPrecision;

    var paymentInterval;

    function validateAddress (callback){
        daemon.cmd('validateaddress', [poolOptions.address], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
    }
    function validateTAddress (callback) {
        daemon.cmd('validateaddress', [poolOptions.tAddress], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
     }
     function validateZAddress (callback) {
        daemon.cmd('z_validateaddress', [poolOptions.zAddress], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
    }

    function getBalance(callback){
        daemon.cmd('getbalance', [], function(result){
            if (result.error){
                return callback(true);
            }
            try {
                var d = result.data.split('result":')[1].split(',')[0].split('.')[1];
                magnitude = parseInt('10' + new Array(d.length).join('0'));
                minPaymentSatoshis = parseInt(processingConfig.minimumPayment * magnitude);
                coinPrecision = magnitude.toString().length - 1;
            }
            catch(e){
                logger.error(logSystem, logComponent, 'Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: ' + result.data);
                return callback(true);
            }
            callback();
        }, true, true);
    }

    function asyncComplete(err){
        if (err){
            setupFinished(false);
            return;
        }
        paymentInterval = setInterval(function(){
            try {
                processPayments();
            } catch(e){
                throw e;
            }
        }, processingConfig.paymentInterval * 1000);
        setTimeout(processPayments, 100);
        setupFinished(true);
    }

    async.parallel([validateAddress, validateTAddress, validateZAddress, getBalance], asyncComplete);

    //get t_address coinbalance
    function listUnspent (addr, notAddr, minConf, displayBool, callback) {
        if (addr !== null) {
            var args = [minConf, 99999999999, [addr]];
        } else {
            addr = 'Payout wallet';
            var args = [minConf, 99999999999];
        }
        daemon.cmd('listunspent', args, function (result) {
            //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
            if (result.error) {
                logger.error(logSystem, logComponent, 'Error trying to get t-addr ['+addr+'] balance with RPC listunspent.'
                    + JSON.stringify(result.error));
                callback = function (){};
                callback(true);
            }
            else {
                var tBalance = 0;
                for (var i = 0, len = result[0].response.length; i < len; i++) {
                    if (result[0].response[i].address !== notAddr) {
                        tBalance = tBalance + (result[0].response[i].amount * magnitude);
                    }
                }
                if (displayBool === true) {
                    logger.special(logSystem, logComponent, addr+' balance of ' + (tBalance / magnitude).toFixed(8));
                }
                callback(null, balanceRound(tBalance).toFixed(8));
            }
        });
    }

    // get z_address coinbalance
    function listUnspentZ (addr, minConf, displayBool, callback) {
        daemon.cmd('z_getbalance', [addr, minConf], function (result) {
            //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
            if (result[0].error) {
                logger.error(logSystem, logComponent, 'Error trying to get coin balance with RPC z_getbalance.' + JSON.stringify(result[0].error));
                callback = function (){};
                callback(true);
            }
            else {
                var zBalance = result[0].response;
                if (displayBool === true) {
                    logger.special(logSystem, logComponent, addr.substring(0,14) + '...' + addr.substring(addr.length - 14) + ' balance: '+(zBalance).toFixed(8));
                }
                callback(null, (zBalance * magnitude).toFixed(8));
            }
        });
    }

    //send t_address balance to z_address
    function sendTToZ (callback, tBalance) {
        if (callback === true)
            return;
        if ((tBalance - 10000) < 0)
            return;

        var amount = balanceRound((tBalance - 10000) / magnitude);
        var params = [poolOptions.address, [{'address': poolOptions.zAddress, 'amount': amount}]];
        daemon.cmd('z_sendmany', params,
            function (result) {
                //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                if (result.error) {
                    logger.error(logSystem, logComponent, 'Error trying to shield mined balance ' + JSON.stringify(result.error));
                    callback = function (){};
                    callback(true);
                }
                else {
                    logger.special(logSystem, logComponent, 'Shield mined balance ' + amount);
                    callback = function (){};
                    callback(null);
                }
            }
        );
    }
	
	function cacheZCashNetworkStats () {
		var params = null;
		daemon.cmd('getmininginfo', params,
            function (result) {
                if (result.error) {
                    logger.error(logSystem, logComponent, 'Error getting stats from zcashd'
                        + JSON.stringify(result.error));
                } else {
					logger.special(logSystem, logComponent, "Updating zcash network stats...");
					var coin = _coin;
					var finalRedisCommands = [];
					finalRedisCommands.push(['hset', coin + ':stats', 'networkBlocks', result[0].response.blocks]);
					finalRedisCommands.push(['hset', coin + ':stats', 'networkDiff', result[0].response.difficulty]);
					finalRedisCommands.push(['hset', coin + ':stats', 'networkSols', result[0].response.networksolps]);
					redisClient.multi(finalRedisCommands).exec(function(error, results){
						if (error){
							logger.error(logSystem, logComponent, 'Could not update zcash stats to redis ' + JSON.stringify(error));
							return;
						}						
					});
                }
				daemon.cmd('getinfo', params,
					function (result) {
						if (result.error) {
							logger.error(logSystem, logComponent, 'Error getting stats from zcashd'
								+ JSON.stringify(result.error));
						} else {
							var coin = _coin;
							var finalRedisCommands = [];
							finalRedisCommands.push(['hset', coin + ':stats', 'networkConnections', result[0].response.connections]);
							redisClient.multi(finalRedisCommands).exec(function(error, results){
								if (error){
									logger.error(logSystem, logComponent, 'Could not update zcash stats to redis ' + JSON.stringify(error));
									return;
								}						
							});	
						}
					}
				);			
			}
        );
	}

    // send z_address balance to t_address
    function sendZToT (callback, zBalance) {
        if (callback === true)
            return;
        if ((zBalance - 10000) < 0)
            return;

        var amount = balanceRound((zBalance - 10000) / magnitude);
        var params = [poolOptions.zAddress, [{'address': poolOptions.tAddress, 'amount': amount}]];
        daemon.cmd('z_sendmany', params,
            function (result) {
                //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                if (result.error) {
                    logger.error(logSystem, logComponent, 'Error trying to send z_address coin balance to payout t_address.'
                        + JSON.stringify(result.error));
                    callback = function (){};
                    callback(true);
                }
                else {
                    logger.special(logSystem, logComponent, 'Prepare funds for payout ' + amount);
                    callback = function (){};
                    callback(null);
                }
            }
        );
    }

    // run coinbase coin transfers every x minutes
	var intervalState = 0; // do not send ZtoT and TtoZ and same time, this results in operation failed!
    var interval = poolOptions.walletInterval * 60 * 1000; // run every x minutes
    setInterval(function() {
		intervalState++;
		switch (intervalState){
			case 1:
			listUnspent(poolOptions.address, null, 1, false, sendTToZ);
			break;
			default:
			listUnspentZ(poolOptions.zAddress, 1, false, sendZToT);
			//listUnspent(null, poolOptions.address, 1, true, function (){}); 
			intervalState = 0;
			break;
		}
		// update zcash stats
		cacheZCashNetworkStats();
    }, interval);

    // check operation statuses every x seconds
    var opid_interval =  poolOptions.walletInterval * 1000;
    setInterval(function(){
       var checkOpIdSuccessAndGetResult = function(ops) {
          ops.forEach(function(op, i){
            if (op.status == "success") {
              daemon.cmd('z_getoperationresult', [[op.id]], function (result) {
                if (result.error) {
                    logger.warning(logSystem, logComponent, 'Unable to get payment operation id result ' + JSON.stringify(result));
                }
                if (result.response) {
		    logger.special(logSystem, logComponent, 'Payment operation success ' + op.id + '  txid: ' + op.result.txid);
                }
              }, true, true);
            } else if (op.status == "failed") {
                if (op.error) {
                  logger.error(logSystem, logComponent, "Payment operation failed " + op.id + " " + op.error.code +", " + op.error.message);
                } else {
                  logger.error(logSystem, logComponent, "Payment operation failed " + op.id);
                }
            }
          });
       };
       daemon.cmd('z_getoperationstatus', null, function (result) {
          if (result.error) {
            logger.warning(logSystem, logComponent, 'Unable to get operation ids for clearing.');
          }
          if (result.response) {
            checkOpIdSuccessAndGetResult(result.response);
          }
       }, true, true);
    }, opid_interval);


    var satoshisToCoins = function(satoshis){
        return parseFloat((satoshis / magnitude).toFixed(coinPrecision));
    };

    var coinsToSatoshies = function(coins){
        return coins * magnitude;
    };

    function balanceRound(number) {
	return parseFloat((Math.round(number * 100000000) / 100000000).toFixed(8));
    }

    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function(){

        var startPaymentProcess = Date.now();

        var timeSpentRPC = 0;
        var timeSpentRedis = 0;

        var startTimeRedis;
        var startTimeRPC;

        var startRedisTimer = function(){ startTimeRedis = Date.now() };
        var endRedisTimer = function(){ timeSpentRedis += Date.now() - startTimeRedis };

        var startRPCTimer = function(){ startTimeRPC = Date.now(); };
        var endRPCTimer = function(){ timeSpentRPC += Date.now() - startTimeRedis };

        async.waterfall([

            /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
               blocks. */
            function(callback){

                startRedisTimer();
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function(error, results){
                    endRedisTimer();

                    if (error){
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var workers = {};
                    for (var w in results[0]){
                        workers[w] = {balance: coinsToSatoshies(parseFloat(results[0][w]))};
                    }

                    var rounds = results[1].map(function(r){
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            serialized: r
                        };
                    });

                    callback(null, workers, rounds);
                });
            },
    

            /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
               It also adds the block reward amount to the round object - which the daemon gives also gives us. */
            function(workers, rounds, callback){

                var batchRPCcommand = rounds.map(function(r){
                    return ['gettransaction', [r.txHash]];
                });
				
				batchRPCcommand.push(['getaccount', [poolOptions.address]]);

                startRPCTimer();
                daemon.batchCmd(batchRPCcommand, function(error, txDetails){
                    endRPCTimer();

                    if (error || !txDetails){
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch gettransactions '
                            + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var addressAccount;

                    txDetails.forEach(function(tx, i){

                        if (i === txDetails.length - 1){
                            addressAccount = tx.result;
                            return;
                        }

                        var round = rounds[i];

                        if (tx.error && tx.error.code === -5){
                            logger.warning(logSystem, logComponent, 'Daemon reports invalid transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)){
                            logger.warning(logSystem, logComponent, 'Daemon reports no details for transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (tx.error || !tx.result){
                            logger.error(logSystem, logComponent, 'Odd error with gettransaction ' + round.txHash + ' '
                                + JSON.stringify(tx));
                            return;
                        }

                        var generationTx = tx.result.details.filter(function(tx){
                            return tx.address === poolOptions.address;
                        })[0];

                        if (!generationTx && tx.result.details.length === 1){
                            generationTx = tx.result.details[0];
                        }

                        if (!generationTx){
                            logger.error(logSystem, logComponent, 'Missing output details to pool address for transaction '
                                + round.txHash);
                            return;
                        }

                        round.category = generationTx.category;
                        if (round.category === 'generate') {
                            round.reward = generationTx.amount - 0.0004 || generationTx.value - 0.0004; // TODO: Adjust fees to be dynamic
                        }

                    });

                    var canDeleteShares = function(r){
                        for (var i = 0; i < rounds.length; i++){
                            var compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)){
                                return false;
                            }
                        }
                        return true;
                    };

                    //Filter out all rounds that are immature (not confirmed or orphaned yet)
                    rounds = rounds.filter(function(r){
                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
                                r.canDeleteShares = canDeleteShares(r);
                            case 'generate':
                                return true;
                            default:
                                return false;
                        }
                    });

                    // check if we have enough tAddress funds to send payments
                    var totalOwed = 0;
                    for (var i = 0; i < rounds.length; i++) {
                        totalOwed = totalOwed + (rounds[i].reward * magnitude) - 4000; // TODO: make tx fees dynamic
                    }
					
                    listUnspent(null, poolOptions.address, 1, false, function (error, tBalance){
                        if (tBalance < totalOwed) {
                            logger.error(logSystem, logComponent, (tBalance / magnitude).toFixed(8) + ' is not enough payment funds to process ' + (totalOwed / magnitude).toFixed(8) + ' of payments. (Possibly due to pending txs)');
                            return callback(true);
                        }
                        else {
                            callback(null, workers, rounds, addressAccount);
                        }
                    })

                });
            },


            /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
               amount owned to each miner for each round. */
            function(workers, rounds, addressAccount, callback){

                var shareLookups = rounds.map(function(r){
                    return ['hgetall', coin + ':shares:round' + r.height]
                });

                startRedisTimer();
                redisClient.multi(shareLookups).exec(function(error, allWorkerShares){
                    endRedisTimer();

                    if (error){
                        callback('Check finished - redis error with multi get rounds share');
                        return;
                    }


                    rounds.forEach(function(round, i){
                        var workerShares = allWorkerShares[i];

                        if (!workerShares){
                            logger.error(logSystem, logComponent, 'No worker shares for round: '
                                + round.height + ' blockHash: ' + round.blockHash);
                            return;
                        }

                        switch (round.category){
                            case 'kicked':
                            case 'orphan':
                                round.workerShares = workerShares;
                                break;

                            case 'generate':
                                /* We found a confirmed block! Now get the reward for it and calculate how much
                                   we owe each miner based on the shares they submitted during that block round. */
                                var reward = parseInt(round.reward * magnitude);

                                var totalShares = Object.keys(workerShares).reduce(function(p, c){
                                    return p + parseFloat(workerShares[c])
                                }, 0);

                                for (var workerAddress in workerShares){
                                    var percent = parseFloat(workerShares[workerAddress]) / totalShares;
                                    var workerRewardTotal = Math.floor(reward * percent);
                                    var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                    worker.reward = (worker.reward || 0) + workerRewardTotal;
                                }
                                break;
                        }
                    });

                    callback(null, workers, rounds, addressAccount);
                });
            },


            /* Calculate if any payments are ready to be sent and trigger them sending
             Get balance different for each address and pass it along as object of latest balances such as
             {worker1: balance1, worker2, balance2}
             when deciding the sent balance, it the difference should be -1*amount they had in db,
             if not sending the balance, the differnce should be +(the amount they earned this round)
             */
            function(workers, rounds, addressAccount, callback) {

                var trySend = function (withholdPercent) {
                    var addressAmounts = {};
                    var totalSent = 0;
                    for (var w in workers) {
                        var worker = workers[w];
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        var toSend = (worker.balance + worker.reward) * (1 - withholdPercent);
                        if (toSend >= minPaymentSatoshis) {
                            totalSent += toSend;
                            var address = worker.address = (worker.address || getProperAddress(w.split('.')[0]));
                            worker.sent = satoshisToCoins(toSend);
                            worker.balanceChange = Math.min(worker.balance, toSend) * -1;                            
                            // multiple workers may have same address, add them up
                            if (addressAmounts[address] != null && addressAmounts[address] > 0) {
								addressAmounts[address] = balanceRound(addressAmounts[address] + worker.sent);
                            } else {
								addressAmounts[address] = worker.sent;
                            }
                        }
                        else {
                            worker.balanceChange = Math.max(toSend - worker.balance, 0);
                            worker.sent = 0;
                        }
                    }

                    if (Object.keys(addressAmounts).length === 0){
                        callback(null, workers, rounds);
                        return;
                    }

console.log("---- Begin Payouts -----");
console.log(JSON.stringify(addressAmounts));
console.log("---- End Payouts -----");

                    daemon.cmd('sendmany', ["", addressAmounts], function (result) {
                        //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                        if (result.error && result.error.code === -6) {
                            var higherPercent = withholdPercent + 0.01;
                            logger.warning(logSystem, logComponent, 'Not enough funds to cover the tx fees for sending out payments, decreasing rewards by '
                                + (higherPercent * 100) + '% and retrying');
                            trySend(higherPercent);
                        }
                        else if (result.error && result.error.code === -5) { // invalid address specified
                            logger.error(logSystem, logComponent, 'Unable to send payments ' + result.error.message);
                            callback(true);
                        }
                        else if (result.error) {
                            logger.error(logSystem, logComponent, 'Error trying to send payments with RPC sendmany '
                                + JSON.stringify(result.error));
                            callback(true);
                        }
                        else {
                            logger.special(logSystem, logComponent, 'Sent out a total of ' + (totalSent / magnitude).toFixed(8)
                                + ' to ' + Object.keys(addressAmounts).length + ' workers');
                            if (withholdPercent > 0) {
                                logger.warning(logSystem, logComponent, 'Had to withhold ' + (withholdPercent * 100)
                                    + '% of reward from miners to cover transaction fees. '
                                    + 'Fund pool wallet with coins to prevent this from happening');
                            }
                            callback(null, workers, rounds);
                        }
                    }, true, true);

                };

                trySend(0);

            },
            function(workers, rounds, callback){

                var totalPaid = 0;

                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];

                for (var w in workers) {
                    var worker = workers[w];
                    if (worker.balanceChange !== 0){
                        balanceUpdateCommands.push([
                            'hincrbyfloat',
                            coin + ':balances',
                            w,
                            satoshisToCoins(worker.balanceChange)
                        ]);
                    }
                    if (worker.sent !== 0){
                        workerPayoutsCommand.push(['hincrbyfloat', coin + ':payouts', w, balanceRound(worker.sent)]);
                        totalPaid = balanceRound(totalPaid + worker.sent);
                    }
                }



                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];

                var moveSharesToCurrent = function(r){
                    var workerShares = r.workerShares;
                    if (workerShares != null) {
	              Object.keys(workerShares).forEach(function(worker){
	                  orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent',
	                      worker, workerShares[worker]]);
	              });
                    }
                };

                rounds.forEach(function(r){

                    switch(r.category){
                        case 'kicked':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
                        case 'orphan':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                            if (r.canDeleteShares){
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                            }
                            return;
                        case 'generate':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
                            roundsToDelete.push(coin + ':shares:round' + r.height);
                            return;
                    }

                });

                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));

                if (totalPaid !== 0)
                    finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', balanceRound(totalPaid)]);

                if (finalRedisCommands.length === 0){
                    callback();
                    return;
                }

                startRedisTimer();
                redisClient.multi(finalRedisCommands).exec(function(error, results){
                    endRedisTimer();
                    if (error){
                        clearInterval(paymentInterval);
                        logger.error(logSystem, logComponent,
                                'Payments sent but could not update redis. ' + JSON.stringify(error)
                                + ' Disabling payment processing to prevent possible double-payouts. The redis commands in '
                                + coin + '_finalRedisCommands.txt must be ran manually');
                        fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function(err){
                            logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                        });
                    }
                    callback();
                });
            }
        ], function(){

            var paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug(logSystem, logComponent, 'Finished interval - time spent: '
                + paymentProcessTime + 'ms total, ' + timeSpentRedis + 'ms redis, '
                + timeSpentRPC + 'ms daemon RPC');

        });
    };


    var getProperAddress = function(address){
        if (address.length === 40){
            return util.addressFromEx(poolOptions.address, address);
        }
        else return address;
    };


}
