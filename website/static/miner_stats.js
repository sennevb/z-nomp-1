var workerHashrateData;
var workerHashrateChart;

var statData;
var workerKeys;
var totalHash;
var totalPaid;

function buildChartData(){

    var workers = {};
	var history = {};

	totalHash = statData.totalHash;
	totalPaid = statData.totalPaid;
	
	var _networkHashRate = parseFloat(statData.networkSols) * 1.1;
	var _myHashRate = (totalHash / 1000000) * 2;
	var luckDays =  ((_networkHashRate / _myHashRate * 150) / (24 * 60 * 60)).toFixed(3);
	$("#statsHashrate").text(getReadableHashRateString(totalHash));
	$("#statsLuckDays").text(luckDays);
	$("#statsTotalPaid").text(totalPaid);
	
    workerKeys = [];
    for (var i = 0; i < statData.workers.length; i++){
        for (var w in statData.workers){
			var worker = w;
			if (w.split(".").length > 0)
				worker = w.split(".")[1];
			
            if (workerKeys.indexOf(w) === -1)
                workerKeys.push(w);
        }
    }

	for (var w in statData.history) {
		var worker = w;
			if (w.split(".").length > 0)
				worker = w.split(".")[1];
			
		var a = workers[worker] = (workers[worker] || {
			hashrate: []
		});
		for (var wh in statData.history[w]) {
			a.hashrate.push([statData.history[w][wh].time * 1000, statData.history[w][wh].hashrate]);
		}
	}
	
    workerHashrateData = [];
    for (var worker in workers){
        workerHashrateData.push({
            key: worker,
            values: workers[worker].hashrate
        });
    }
}

function getReadableHashRateString(hashrate){
    if (hashrate < 1000000)
        return '0 Sol';
    var byteUnits = [ ' Sol/s', ' KSol/s', ' MSol/s', ' GSol/s', ' TSol/s', ' PSol/s' ];
    hashrate = (hashrate * 2);
    var i = Math.floor((Math.log(hashrate/1000) / Math.log(1000)) - 1);
    hashrate = (hashrate/1000) / Math.pow(1000, i + 1);
    return hashrate.toFixed(2) + byteUnits[i];
}

function timeOfDayFormat(timestamp){
    var dStr = d3.time.format('%I:%M %p')(new Date(timestamp));
    if (dStr.indexOf('0') === 0) dStr = dStr.slice(1);
    return dStr;
}

function displayCharts(){

    nv.addGraph(function() {
        workerHashrateChart = nv.models.lineChart()
            .margin({left: 80, right: 30})
            .x(function(d){ return d[0] })
            .y(function(d){ return d[1] })
            .useInteractiveGuideline(true);

        workerHashrateChart.xAxis.tickFormat(timeOfDayFormat);

        workerHashrateChart.yAxis.tickFormat(function(d){
            return getReadableHashRateString(d);
        });

        d3.select('#workerHashrate').datum(workerHashrateData).call(workerHashrateChart);

        return workerHashrateChart;
    });
	
}

function TriggerChartUpdates(){
    workerHashrateChart.update();
}

nv.utils.windowResize(TriggerChartUpdates);

$.getJSON('/api/worker_stats?'+_miner, function(data){
    statData = data;
    buildChartData();
    displayCharts();
});

statsSource.addEventListener('message', function(e){
	$.getJSON('/api/worker_stats?'+_miner, function(data){
		statData = data;
		buildChartData();
		displayCharts();
	});
});

