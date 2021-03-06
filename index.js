
const core = require('@actions/core');
const github = require('@actions/github');
const glob = require('@actions/glob');
const parser = require('xml2json');
const axios = require('axios');
const fs = require('fs');


(async () => {
	try {
		const path = core.getInput('path');
		const includeSummary = core.getInput('includeSummary');
		const numFailures = core.getInput('numFailures');
		const accessToken = core.getInput('access-token');
		const testSrcPath = core.getInput('testSrcPath');
		const slackBotToken = core.getInput('slack-bot-token');
		const slackChannelId = core.getInput('slack-channel-id');
		const globber = await glob.create(path, {followSymbolicLinks: false});

		let numTests = 0;
		let numSkipped = 0;
		let numFailed = 0;
		let numErrored = 0;
		let testDuration = 0;

		let annotations = [];

		const octokit = new github.GitHub(accessToken);
		const req = {
			...github.context.repo,
			ref: github.context.sha
		}
		const res = await octokit.checks.listForRef(req);

		const check_run_id = res.data.check_runs.filter(check => check.name === 'build')[0].id

		for await (const file of globber.globGenerator()) {
			const data = await fs.promises.readFile(file);
			var json = JSON.parse(parser.toJson(data));
			if (json.testsuite) {
				const testsuite = json.testsuite;
				testDuration += Number(testsuite.time);
				numTests += Number(testsuite.tests);
				numErrored += Number(testsuite.errors);
				numFailed += Number(testsuite.failures);
				numSkipped += Number(testsuite.skipped);
				testFunction = async testcase => {
					const problem = testcase.failure || testcase.error;
					if (problem) {
						if (numFailures === "0" || annotations.length < numFailures) {
							const klass = testcase.classname.replace(/$.*/g, '').replace(/\./g, '/');
							const path = `${testSrcPath}${klass}.java`

							const file = await fs.promises.readFile(path, {encoding: 'utf-8'});
							//TODO: make this better won't deal with methods with arguments etc
							let line = 0;
							const lines = file.split('\n')
							for (let i = 0; i < lines.length; i++) {
								if (lines[i].indexOf(testcase.name) >= 0) {
									line = i;
									break;
								}
							}

							const descriptor = testcase.failure ? 'Failure' : 'Error';
							annotations.push({
								path: path,
								start_line: line,
								end_line: line,
								start_column: 0,
								end_column: 1,
								annotation_level: 'failure',
								message: `Test ${testcase.name} ${descriptor} ${problem.message}`,
							});

							const owner = github.context.repo.owner;
							const repo = github.context.repo.repo;
							const lineNum = /:(\d+)\)/g.exec(problem.$t)[1]
							const branch = github.context.ref.replace("refs/heads/", "");
							const message = problem.message
									? problem.message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
									: "No message found";

							const slackMessage = "*Test " + descriptor
									+ "* | <https://github.com/" + owner + "/" + repo + "/runs/" + check_run_id + "|" + owner + ":" + repo + "@" + branch + ">"
									+ " - `" + testcase.name + "`:\n```" + message
									+ "``` <https://github.com/" + owner + "/" + repo
									+ "/blob/" + branch + "/" + path + "#L" + lineNum + "|" + path + ">";

							await axios({
								url: "https://slack.com/api/chat.postMessage",
								method: "post",
								headers: {
									"Authorization": `Bearer ${slackBotToken}`,
									"Content-type": "application/json"
								},
								data: {
									"channel": slackChannelId,
									"blocks": [
										{
											"type": "section",
											"text": {
												"type": "mrkdwn",
												"text": slackMessage
											}
										}
									]
								}
							});
						}
						//add
					}
				}

				if (Array.isArray(testsuite.testcase)) {
					for (const testcase of testsuite.testcase) {
						await testFunction(testcase)
					}
				} else {
					//single test
					await testFunction(testsuite.testcase)
				}
			}
		}


		const annotation_level = numFailed + numErrored > 0 ? 'failure' : 'notice';
		const annotation = {
			path: 'test',
			start_line: 0,
			end_line: 0,
			start_column: 0,
			end_column: 0,
			annotation_level,
			message: `Junit Results ran ${numTests} in ${testDuration} seconds ${numErrored} Errored, ${numFailed} Failed, ${numSkipped} Skipped`,
		};

		const update_req = {
			...github.context.repo,
			check_run_id,
			output: {
				title: "Junit Results",
				summary: `Num passed etc`,
				annotations: [annotation, ...annotations]
			}
		}
		await octokit.checks.update(update_req);
	} catch (error) {
		core.setFailed(error.message);
	}
})();
