const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const srcPath = process.argv[2];
const dstPath = process.argv[3];
const videoName = path.basename(dstPath);
const dstParent = path.dirname(dstPath);
const tmpPath = `${dstParent}/_${videoName}`;
const logPath = process.argv[4];

const printLog = (log) => {
    console.log(log);
    !!logPath && fs.appendFileSync(logPath, `${log}\n`);
}
const printErr = (err) => {
    console.log(`Error: ${err}`);
    !!logPath && fs.appendFileSync(logPath, `Error: ${err}\n`);
}
const printProcess = (percent) => {
    console.log(`conversion process: ${percent}%`);
}

const asyncCheckArgv = () => {
	return new Promise((resolve, reject) => {
        if (fs.existsSync(dstPath)) {
            reject({ code: 1, msg: `dstPath ${dstPath} already exists.` });
        }
        
        if (!fs.existsSync(`${__dirname}/ffprobe_32.exe`)){
            reject({ code: 5, msg: `${__dirname}/ffprobe_32.exe not exists` });
        }
        
        if (!fs.existsSync(`${__dirname}/ffmpeg_32.exe`)){
            reject({ code: 6, msg: `${__dirname}/ffmpeg_32.exe not exists` });
        }
        
        if (!fs.existsSync(`${__dirname}/enc.key`)){
            reject({ code: 7, msg: `${__dirname}/enc.key not exists` });
        }
        resolve();
	});
}

const asyncClassify = () => {
	return new Promise((resolve, reject) => {
		printLog(`trying classify ${srcPath} with ffprobe, __dirname: ${__dirname}`);
        let result_str = "", result, iClass; // A:0, B:1, C:2;
        
        const classify = spawn(`${__dirname}/ffprobe_64.exe`, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration', '-show_entries', 'stream=width,height', '-of', 'json', srcPath]);
        printLog(`ffprobe called`);
        classify.stdout.on('data', (data) => {
            printLog(`stdout: ${data}`);
            result_str += data;
        });

        classify.stderr.on('data', (data) => {
            printErr(`stderr: ${data.toString()}`);
        });

        classify.on('close', (code) => {
            printLog(`child process exited with code ${code}`);
            try {
                result = JSON.parse(result_str);
            } catch {
                reject({ code: 3, msg: `failed to parse ${result_str}` });
            }

            printLog("ffprobe result:");
            printLog(JSON.stringify(result));
            if (result && result.streams && result.streams[0]) {
                const duration = parseFloat(result.format.duration);
                if (result.streams[0]['height'] > 720) {
                    iClass = -1; // 1080p, 720p, 480p, 360p, 240p, 144p
                } else if (result.streams[0]['height'] > 480) {
                    iClass = 0; // 720p, 480p, 360p, 240p, 144p
                } else if (result.streams[0]['height'] >= 360) {
                    iClass = 1; // 480p, 360p, 240p, 144p
                } else {
                    iClass = 2; // 360p, 240p, 144p
                }
                const ratio = result.streams[0]['width'] / result.streams[0]['height'];
                resolve({ iClass, ratio, duration });
            } else {
                reject({ code: 4, msg: `result is empty` });
            }
        });
	});
}

const asyncConvert = (iClass, ratio, duration, doEnc) => {
	return new Promise((resolve, reject) => {
		printLog(`trying convert ${srcPath} with ffmpeg, iClass = ${iClass}, ratio = ${ratio}, tmpPath = ${tmpPath}, duration = ${duration}`);
        fs.writeFileSync(`${__dirname}/enc.keyinfo`, `https://gd.yinbo2020.com/enc.key\n${__dirname}/enc.key`);
		let ffmpegOptions = ['-hide_banner', '-y', '-i', srcPath, '-threads', '2'];
		const sharedOptions = [
            '-c:a', 'aac',
            '-ar', '44100',
			//gpu accell
			'-hwaccel', 'cuda',
			'-hwaccel_output_format', 'cuda',
            '-c:v', 'h264_nvenc',
            '-profile:v', 'high',
            '-r', '25',
            '-crf', '20',
            '-sc_threshold', '0',
            '-g', '48',
            '-keyint_min', '48',
            '-hls_time', '6',
            '-hls_playlist_type', 'vod',
            '-b:a', '128k',
            '-start_number', '1',
            '-ss', '0', '-t', duration
        ];
        doEnc && sharedOptions.push('-hls_key_info_file', `${__dirname}/enc.keyinfo`);
        let main_m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n";
		printLog(`Start to convert ${srcPath}`);
		!fs.existsSync(tmpPath) && fs.mkdirSync(tmpPath);

		let height, width;
		if (iClass <= 2) {
			const xxldDstPath = tmpPath + "/videoHlsXXld";
			!fs.existsSync(xxldDstPath) && fs.mkdirSync(xxldDstPath);
			height = 144;
			width = Math.round(height * ratio / 2) * 2;
			ffmpegOptions = ffmpegOptions.concat(sharedOptions).concat(['-vf', `scale=${width}:${height}`, '-b:v', '50k', '-maxrate', '50k', '-bufsize', '50k', '-hls_segment_filename', xxldDstPath + '/video-%05d.ts', xxldDstPath + '/video.m3u8']);
			main_m3u8 = main_m3u8 + "#EXT-X-STREAM-INF:BANDWIDTH=250000,RESOLUTION=256x144\nvideoHlsXXld/video.m3u8\n";

			const xldDstPath = tmpPath + "/videoHlsXld";
			!fs.existsSync(xldDstPath) && fs.mkdirSync(xldDstPath);
			height = 240;
			width = Math.round(height * ratio / 2) * 2;
			ffmpegOptions = ffmpegOptions.concat(sharedOptions).concat(['-vf', `scale=${width}:${height}`, '-b:v', '100k', '-maxrate', '100k', '-bufsize', '100k', '-hls_segment_filename', xldDstPath + '/video-%05d.ts', xldDstPath + '/video.m3u8']);
			main_m3u8 = main_m3u8 + "#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=426x240\nvideoHlsXld/video.m3u8\n";

			const ldDstPath = tmpPath + "/videoHlsLd";
			!fs.existsSync(ldDstPath) && fs.mkdirSync(ldDstPath);
			height = 360;
			width = Math.round(height * ratio / 2) * 2;
			ffmpegOptions = ffmpegOptions.concat(sharedOptions).concat(['-vf', `scale=${width}:${height}`, '-b:v', '200k', '-maxrate', '200k', '-bufsize', '200k', '-hls_segment_filename', ldDstPath + '/video-%05d.ts', ldDstPath + '/video.m3u8']);
			main_m3u8 = main_m3u8 + "#EXT-X-STREAM-INF:BANDWIDTH=550000,RESOLUTION=640x360\nvideoHlsLd/video.m3u8\n";
		}
		if (iClass <= 1) {
			const sdDstPath = tmpPath + "/videoHlsSd";
			!fs.existsSync(sdDstPath) && fs.mkdirSync(sdDstPath);
			height = 480;
			width = Math.round(height * ratio / 2) * 2;
			ffmpegOptions = ffmpegOptions.concat(sharedOptions).concat(['-vf', `scale=${width}:${height}`, '-b:v', '700k', '-maxrate', '700k', '-bufsize', '700k', '-hls_segment_filename', sdDstPath + '/video-%05d.ts', sdDstPath + '/video.m3u8']);
			main_m3u8 = main_m3u8 + "#EXT-X-STREAM-INF:BANDWIDTH=950000,RESOLUTION=854x480\nvideoHlsSd/video.m3u8\n";
		}
		if (iClass <= 0) {
			const hdDstPath = tmpPath + "/videoHlsHd";
			!fs.existsSync(hdDstPath) && fs.mkdirSync(hdDstPath);
			height = 720;
			width = Math.round(height * ratio / 2) * 2;
			ffmpegOptions = ffmpegOptions.concat(sharedOptions).concat(['-vf', `scale=${width}:${height}`, '-b:v', '1300k', '-maxrate', '1300k', '-bufsize', '1300k', '-hls_segment_filename', hdDstPath + '/video-%05d.ts', hdDstPath + '/video.m3u8']);
			main_m3u8 = main_m3u8 + "#EXT-X-STREAM-INF:BANDWIDTH=1650000,RESOLUTION=1280x720\nvideoHlsHd/video.m3u8\n";
		}
		if (iClass <= -1) {
			const fhdDstPath = tmpPath + "/videoHlsFhd";
			!fs.existsSync(fhdDstPath) && fs.mkdirSync(fhdDstPath);
			height = 1080;
			width = Math.round(height * ratio / 2) * 2;
			ffmpegOptions = ffmpegOptions.concat(sharedOptions).concat(['-vf', `scale=${width}:${height}`, '-b:v', '2300k', '-maxrate', '2300k', '-bufsize', '2300k', '-hls_segment_filename', fhdDstPath + '/video-%05d.ts', fhdDstPath + '/video.m3u8']);
			main_m3u8 = main_m3u8 + "#EXT-X-STREAM-INF:BANDWIDTH=3250000,RESOLUTION=1920x1080\nvideoHlsFhd/video.m3u8\n";
		}
		fs.writeFileSync(tmpPath + "/" + videoName + ".m3u8", main_m3u8);

		printLog(JSON.stringify(ffmpegOptions));
		const convert = spawn(`${__dirname}/ffmpeg_64.exe`, ffmpegOptions);

		convert.stdout.on('data', (data) => {
			printLog(`stdout: ${data.toString()}`);
		});

		convert.stderr.on('data', (data) => {
			// printErr(`stderr: ${data}`);
			printLog(`${data.toString()}`);
            const currentPosition = data.toString().match(/^frame[\w\d\/=\s\.]+time=([\d:\.]+)\s[\w\d\/=\s\.]+$/);
            if (!!currentPosition) {
                const HMS = currentPosition[1];
                const HMSArray = HMS.split(':');
                const seconds = (+HMSArray[0]) * 60 * 60 + (+HMSArray[1]) * 60 + (+HMSArray[2]);
                printProcess( Math.round((seconds/duration)*50) + (doEnc?0:50) );
            }
		});

		convert.on('close', (code) => {
			printLog(`child process exited with code ${code}`);
			if (code > 0) {
				reject({ code: 2, msg: `Conversion failed` });
			} else {
				printLog(`${videoName} convert completed, doEnc: ${doEnc}`)
				resolve({ iClass, ratio, duration });
			}
		});
	});
}

const asyncRenameEnc = (iClass, ratio, duration) => {
	return new Promise((resolve, reject) => {
        printLog("rename " + tmpPath + "/" + videoName + ".m3u8");
        fs.renameSync(tmpPath + "/" + videoName + ".m3u8", tmpPath + "/" + videoName + ".m3u8" + ".enc");
        const subPaths = [];
        if (iClass <= 2) {
            subPaths.push("videoHlsXXld", "videoHlsXld", "videoHlsLd");
        }
        if (iClass <= 1) {
            subPaths.push("videoHlsSd");
        }
        if (iClass <= 0) {
            subPaths.push("videoHlsHd");
        }
        if (iClass <= -1) {
            subPaths.push("videoHlsFhd");
        }
        subPaths.forEach((d)=>{
            printLog(d);
            printLog("rename " + tmpPath + "/" + d + "/video.m3u8");
            fs.renameSync(tmpPath + "/" + d + "/video.m3u8", tmpPath + "/" + d + "/video.m3u8" + ".enc");
            printLog("renamed " + tmpPath + "/" + d + "/video.m3u8");
            fs.readdirSync(tmpPath + "/" + d).forEach((tsFile)=>{
                if (tsFile.endsWith(".ts")) {
                    if (tsFile.endsWith("7.ts")) {
                        printLog("rename " + tmpPath + "/" + d + "/" + tsFile);
                        fs.renameSync(tmpPath + "/" + d + "/" + tsFile, tmpPath + "/" + d + "/" + tsFile + ".enc");
                    }else{
                        printLog("remove " + tmpPath + "/" + d + "/" + tsFile);
                        fs.unlinkSync(tmpPath + "/" + d + "/" + tsFile);
                    }
                }else{
                    // do nothing
                }
            });
        });
        resolve({ iClass, ratio, duration });
	});
}

const asyncRenameUnenc = () => {
	return new Promise((resolve, reject) => {
        const subPaths = fs.readdirSync(tmpPath);
        const main_m3u8 = fs.readFileSync(tmpPath + "/" + videoName + ".m3u8").toString();
        const unenc_main_m3u8 = main_m3u8.replace(/video.m3u8\n/g, 'video_unenc.m3u8\n');
        const sub_m3u8 = fs.readFileSync(tmpPath+"/videoHlsLd/video.m3u8").toString();
        const sub_unenc_m3u8 = sub_m3u8.replace(/7.ts\n/g, '7_unenc.ts\n');
        fs.writeFileSync(tmpPath + "/" + videoName + "_unenc.m3u8", unenc_main_m3u8);
        printLog("rename " + tmpPath + "/" + videoName + ".m3u8" + ".enc");
        fs.renameSync(tmpPath + "/" + videoName + ".m3u8" + ".enc", tmpPath + "/" + videoName + ".m3u8");
        subPaths.forEach((d)=>{
            printLog(d);
            if (d.startsWith("videoHls")){
                printLog(d);
                printLog("rename " + tmpPath + "/" + d + "/video.m3u8" + ".enc");
                fs.renameSync(tmpPath + "/" + d + "/video.m3u8" + ".enc", tmpPath + "/" + d + "/video.m3u8");
                fs.writeFileSync(tmpPath + "/" + d + "/video_unenc.m3u8", sub_unenc_m3u8);
                fs.readdirSync(tmpPath + "/" + d).forEach((tsFile)=>{
                    if (tsFile.endsWith("7.ts")) {
                        printLog("rename " + tmpPath + "/" + d + "/" + tsFile);
                        fs.renameSync(tmpPath + "/" + d + "/" + tsFile, tmpPath + "/" + d + "/" + tsFile.replace(/7.ts/, "7_unenc.ts"));
                    }else{
                        // do nothing
                    }
                });
            }
        });
        subPaths.forEach((d)=>{
            printLog(d);
            if (d.startsWith("videoHls")){
                printLog(d);
                fs.readdirSync(tmpPath + "/" + d).forEach((tsFile)=>{
                    if (tsFile.endsWith("7.ts.enc")) {
                        printLog("rename " + tmpPath + "/" + d + "/" + tsFile);
                        fs.renameSync(tmpPath + "/" + d + "/" + tsFile, tmpPath + "/" + d + "/" + tsFile.replace(/.enc$/, ''));
                    }else{
                        // do nothing
                    }
                });
            }
        });
        printLog(`rename ${tmpPath} as ${dstPath}`);
        fs.renameSync(tmpPath, dstPath);
        resolve();
	});
}

printLog(`================== ${srcPath} ==================`);
asyncCheckArgv()
	.then(() => {
		return asyncClassify();
	})
	.then((result) => {
		return asyncConvert(result.iClass, result.ratio, result.duration, true);
	})
	.then((result) => {
		return asyncRenameEnc(result.iClass, result.ratio, result.duration);
	})
	.then((result) => {
		return asyncConvert(result.iClass, result.ratio, result.duration, false);
	})
	.then(() => {
		return asyncRenameUnenc();
	})
	.catch((err) => {
		printLog(`error message: ${err.msg}`);
		process.exit(err.code);
	})
	.finally(() => {
		process.exit(0);
	});