/*
HTCRAWL - 1.0
http://htcrawl.org
Author: filippo@fcvl.net

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation; either version 2 of the License, or (at your option) any later
version.
*/

"use strict";

const puppeteer = require('puppeteer');
const defaults = require('./options').options;
const probe = require("./probe");
const textComparator = require("./shingleprint");

const utils = require('./utils');
const process = require('process');
const CRAWL_LOOP_TIME = 50;
const TRIGGER_SLEEP = 200;
const REQUEST_ABORTED = 'aborted';
const REQUEST_FAILED = 'failed';
const fs = require('fs');


/**
 * Constructs the list of arguments to pass to Chrome.
 * @param {Object} options - Configuration options for Chrome.
 * @returns {Array} - List of Chrome arguments.
 */
const getChromeArgs = (options = {}) => {
	const baseArgs = [
		'--no-sandbox',
		'--disable-setuid-sandbox',
		'--disable-gpu',
		'--hide-scrollbars',
		'--mute-audio',
		'--ignore-certificate-errors',
		'--ignore-certificate-errors-spki-list',
		'--ssl-version-max=tls1.3',
		'--ssl-version-min=tls1',
		'--disable-web-security',
		'--allow-running-insecure-content',
		'--proxy-bypass-list=<-loopback>',
		'--window-size=1300,1000'
	];

	if (options.proxy) {
		baseArgs.push(`--proxy-server=${options.proxy}`);
	}

	if (options.openChromeDevtools) {
		baseArgs.push('--auto-open-devtools-for-tabs');
	}

	return Object.keys(defaults).reduce((args, key) => {
		if (!(key in options)) options[key] = defaults[key];
		return args;
	}, baseArgs);
};

/**
 * Launches a Puppeteer browser instance with the given options.
 * @param {Object} options - Configuration options for the browser.
 * @returns {Promise} - A promise that resolves to the browser instance.
 */
const launchBrowser = async (options) => {
	const chromeArgs = getChromeArgs(options);

	try {
		return await puppeteer.launch({
			headless: options.headlessChrome,
			ignoreHTTPSErrors: true,
			args: chromeArgs
		});
	} catch (error) {
		// this._logError("launchbrowser", `Error launching browser: ${error}`);
		console.error("Error launching browser:", error);
		throw error;
	}
};

/**
 * Handles individual requests for the crawler.
 * @param {Object} crawler - The Crawler instance.
 * @param {Object} request - The request to be handled.
 * @returns {Promise} - A promise that resolves to true if request is handled, else false.
 */
const handleRequestNew = async (crawler, request) => {
	const events = {xhr: "xhrCompleted", fetch: "fetchCompleted"};
	// console.log(request.p)

	if (request.p.response()) {
		// console.log('Hi1')
		let responseText = null;
		try {
			// console.log('Hi2')
			responseText = await request.p.response().text();
			// console.log(responseText)
		} catch (error) {
			// this._logError("handleRequestNew", `Error fetching response text: ${error}`);
			console.error("Error fetching response text:", error);
		}
		// console.log('Hi3')
		if (request.h.type !== "formsubmit") {
            await crawler.dispatchProbeEvent(events[request.h.type], {
                request: request.h,
                response: responseText
            });
        }
		// console.log('Hi4')

		return true;
	}
	return false;
};

/**
 * Loops through and processes pending requests for the crawler.
 * @param {Object} crawler - The Crawler instance.
 */
const requestLoop = async (crawler) => {
	if (!crawler || !Array.isArray(crawler._pendingRequests)) {
		this._logError("requestLoop", `"Crawler object or its _pendingRequests is not correctly defined.`);
		throw new Error("Crawler object or its _pendingRequests is not correctly defined.");
	}

	for (let i = crawler._pendingRequests.length - 1; i >= 0; i--) {
		const request = crawler._pendingRequests[i];
		console.log(request);
		try{
			if (handleRequestNew(crawler, request) || request.p.failure()) {
				crawler._pendingRequests.splice(i, 1);
			}
		}catch (error) {
			// this._logError("requestLoop", `Error in req loop: ${error}`);
			console.log("Error in req loop:", error);
		}
		
		
	}
	// Schedule the next iteration of the loop
	setTimeout(() => requestLoop(crawler), CRAWL_LOOP_TIME);
};

/**
 * Closes newly created browser targets if not allowed by the crawler.
 * @param {Object} crawler - The Crawler instance.
 * @param {Object} target - The browser target to be checked.
 */
const handleTargetCreated = async (crawler, target) => {
	if (crawler._allowNewWindows) return;
	const p = await target.page();
	if (p) await p.close();
};

/**
 * Launches a Puppeteer browser, initializes a crawler, and starts processing requests.
 * @param {string} url - The starting URL for the crawler.
 * @param {Object} options - Configuration options.
 * @returns {Promise} - A promise that resolves to the initialized Crawler instance.
 */
exports.launch = async (url, options = {}) => {
	const browser = await launchBrowser(options);
	const crawler = new Crawler(url, options, browser);

	await crawler.bootstrapPage();

	setTimeout(() => requestLoop(crawler), CRAWL_LOOP_TIME);

	browser.on("targetcreated", (target) => handleTargetCreated(crawler, target));

	return crawler;
};

/**
 * Crawler constructor function to initialize and manage a crawling session.
 * 
 * @constructor
 * @param {string} targetUrl - The target URL to start crawling from.
 * @param {Object} options - Configuration options for the crawler.
 * @param {Object} browser - The Puppeteer browser instance.
 */
function Crawler(targetUrl, options, browser){
	this._setTargetUrl(targetUrl);

	this.publicProbeMethods = [''];
	this._cookies = [];
	this._redirect = null;
	this._errors = [];
	this._loaded = false;
	this._allowNavigation = false;
	this._allowNewWindows = false;
	this._firstRun = true;
	this.error_codes = ["contentType","navigation","response"];

	this.probeEvents = {
		start: function(){},
		xhr: function(){},
		xhrcompleted: function(){},
		fetch: function(){},
		fetchcompleted: function(){},
		jsonp: function(){},
		jsonpcompleted: function(){},
		websocket: function(){},
		websocketmessage: function(){},
		websocketsend: function(){},
		formsubmit: function(){},
		fillinput: function(){},
		//requestscompleted: function(){},
		//dommodified: function(){},
		newdom: function(){},
		navigation: function(){},
		domcontentloaded: function(){},
		//blockedrequest: function(){},
		redirect: function(){},
		earlydetach: function(){},
		triggerevent: function(){},
		eventtriggered: function(){},
		pageinitialized: function(){}
		//end: function(){}
	}


	this.options = options;

	this._browser = browser;
	this._page = null;

	this._trigger = {};
	this._pendingRequests =[];
	this._sentRequests = [];
	this.documentElement = null;
	this.domModifications = [];
	this.submittedFormsSet = new Set();
	this.formQueue = [];
	this._stop = false;
}

/**
 * Sets the target URL for the crawler. Ensures the URL starts with 'http' or 'https'.
 * 
 * @private
 * @param {string} url - The URL to set as the target.
 */
Crawler.prototype._setTargetUrl = function(url){
	if (typeof url !== 'string' || !url.trim()) {
		this._logError("TargetURL", `Invalid URL provided.`);
		throw new Error("Invalid URL provided.");
	}
	url = url.trim();
	if (!url.startsWith("http")) {
		url = `http://${url}`;
	}
	this.targetUrl = url;
}

/**
 * Retrieves the browser instance associated with the crawler.
 * 
 * @public
 * @returns {Object} - The Puppeteer browser instance.
 */
Crawler.prototype.browser = function(){
	if (!this._browser) {
		this._logError("Browser", `Browser instance not initialized.`);
		throw new Error("Browser instance not initialized.");
	}
	return this._browser;
}

/**
 * Retrieves the page instance associated with the crawler.
 * 
 * @public
 * @returns {Object} - The Puppeteer page instance.
 */
Crawler.prototype.page = function(){
	if (!this._page) {
		this._logError("page", `Page instance not initialized.`);
		throw new Error("Page instance not initialized.");
	}
	return this._page;
}

/**
 * Fetches and returns the cookies set during the crawling session.
 * 
 * @public
 * @async
 * @returns {Array} - An array of cookies.
 */
Crawler.prototype.cookies = async function(){
	var pcookies = [];
	if(this._page){
		try {
			const cookies = await this._page.cookies();
			for (let c of cookies) {
				pcookies.push({
					name: c.name,
					value: c.value,
					domain: c.domain,
					path: c.path,
					expires: c.expires,
					httponly: c.httpOnly,
					secure: c.secure
				});
				this._cookies = this._cookies.filter( (el) => {
					if(el.name != c.name){
						return el;
					}
				})
			}
		} catch (error) {
			this._logError("cookies", `Error fetching cookies: ${error}`);
			console.error("Error fetching cookies:", error);
		}
	}
	return [...this._cookies, ...pcookies];
}

/**
 * Logs and stores errors encountered during the crawler's operations.
 * 
 * @public
 * @param {string} category - The category or type of the error.
 * @param {string} message - A detailed error message.
 */
 Crawler.prototype._logError = function(category, message) {
	this._errors.push([category, message]);
	console.error(message);
}

/**
 * Retrieves the redirect information.
 * 
 * @public
 * @returns {Object} - The redirect object.
 */
Crawler.prototype.redirect = function(){
	return this._redirect;
}

/**
 * Retrieves the errors encountered during crawling.
 * 
 * @public
 * @returns {Array} - An array of errors.
 */
Crawler.prototype.errors = function(){
	return this._errors;
}

/**
 * Initiates the loading process for the target URL.
 * 
 * @public
 * @async
 * @returns {Promise} - Resolves to the Crawler instance after navigation.
 */
Crawler.prototype.load = async function(){
	try{
		const resp = await this._goto(this.targetUrl);
		return await this._afterNavigation(resp);
	} catch (error) {
		this._logError("load", `Error in load: ${error}`);
		console.error("Error in load:", error);
	}
};

/**
 * Navigates to the provided URL.
 * 
 * @private
 * @async
 * @param {string} url - The URL to navigate to.
 * @returns {Promise} - Resolves to the navigation response.
 */
 Crawler.prototype._goto = async function(url) {
	if (this.options.verbose) console.log("LOAD");
	this._allowNavigation = true;
	try {
		return await this._page.goto(url, { waitUntil: 'load' });
	} catch (e) {
		this._logError("navigation", `Navigation failed: ${e.message}`);
		console.error("Navigation failed:", e.message);
		return null;  // Explicitly return null in case of an error
	} finally {
		this._allowNavigation = false;
	}
}

/**
 * Handles post-navigation tasks such as verifying content type and setting up DOM observers.
 * 
 * @private
 * @async
 * @param {Object} resp - The navigation response.
 * @returns {Promise} - Resolves to the Crawler instance.
 */
Crawler.prototype._afterNavigation = async function(resp){
	const assertContentType = (hdrs) => {
		const ctype = hdrs['content-type'] || "";
		if (ctype.toLowerCase().split(";")[0] !== "text/html") {
			this._logError("content_type", `Content type is ${ctype}`);
			return false;
		}
		return true;
	}
	try{
		if (!resp.ok()) {
			this._logError("response", `${resp.request().url()} status: ${resp.status()}`);
			throw new Error(`Response not OK: ${resp.status()}`);
		}
		const hdrs = resp.headers();
		this._cookies = utils.parseCookiesFromHeaders(hdrs, resp.url())


		if (!assertContentType(hdrs)) {
			throw new Error("Content type is not text/html");
		}
		this.documentElement = await this._page.evaluateHandle( () => document.documentElement);

		await this._page.evaluate(async() => {
			window.__PROBE__.DOMMutations = [];
			const observer = new MutationObserver(mutations => {
				mutations.forEach(m => {
					if (m.type == 'childList' && m.addedNodes.length) {
						m.addedNodes.forEach(e => window.__PROBE__.DOMMutations.push(e));
					}
				});
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
		});

		this._loaded = true;

		await this.dispatchProbeEvent("domcontentloaded", {});
		await this.waitForRequestsCompletion(this._page);
		await this.dispatchProbeEvent("pageinitialized", {});

		return this;
	}catch (error) {
		this._logError("_afterNavigation", `Error during _afterNavigation: ${error}`);
		console.error("Error during _afterNavigation:", error);
		throw error;
	}
};

Crawler.prototype.waitForRequestsCompletion = async function(page){
	await this._waitForRequestsCompletion();
	await page.evaluate(async function(){ // use Promise.all ??
		await window.__PROBE__.waitJsonp();
		await window.__PROBE__.waitWebsocket();
	});
};

Crawler.prototype.start = async function(){

	if(!this._loaded){
		await this.load();
	}

	try {
		this._stop = false;
		await this.fillInputValues(this._page);
		const domArr = await this.getDOMTreeAsArray(this._page);
		console.log(domArr.length)
		await this.crawlDOM();
		return this;
	}catch(e){
		this._errors.push(["navigation","navigation aborted"]);
		//_this.dispatchProbeEvent("end", {});
		throw e;
	}
}




Crawler.prototype.stop = function(){
	this._stop = true;
}


Crawler.prototype.on = function(eventName, handler){
	eventName = eventName.toLowerCase();
	if(!(eventName in this.probeEvents)){
		throw("unknown event name: " + eventName);
	}
	this.probeEvents[eventName] = handler;
};


Crawler.prototype.probe = function(method, args){
	var _this = this;

	return new Promise( (resolve, reject) => {
		_this._page.evaluate( async (method, args) => {
			var r = await window.__PROBE__[method](...args);
			return r;
		}, [method, args]).then( ret => resolve(ret));
	})
}


Crawler.prototype.dispatchProbeEvent = async function(name, params) {
	name = name.toLowerCase();
	var ret, evt = {
		name: name,
		params: params || {}
	};

	ret = await this.probeEvents[name](evt, this);
	if(ret === false){
		return false;
	}

	if(typeof ret == "object"){
		return ret;
	}

	return true;
}

Crawler.prototype.handleRequest = async function(req){
	// console.log(req)
	let extrah = {}
	try {
		extrah = req.headers();
	} catch (error) {
		console.warn("Could not retrieve headers:", error);
	}
	let type = req.resourceType(); // xhr || fetch
	if (type == 'document') type = 'xhr';
	delete extrah['referer'];
	delete extrah['user-agent'];
	let r = new utils.Request(type, req.method(), req.url().split("#")[0], req.postData(), this._trigger, extrah);
	let rk = r.key();
	if(this._sentRequests.indexOf(rk) != -1){
		req.abort('aborted');
		return;
	}
	for(let ex of this.options.excludedUrls){
		if(r.url.match(ex)){
			req.abort('aborted');
			return;
		}
	}
	// add to pending ajax before dispatchProbeEvent.
	// Since dispatchProbeEvent can await for something (and take some time) we need to be sure that the current xhr is awaited from the main loop
	let ro = {p:req, h:r};
	// console.log(ro);
	this._pendingRequests.push(ro);
	let uRet = await this.dispatchProbeEvent(type, {request:r});
	if(uRet){
		req.continue();
	} else {
		this._pendingRequests.splice(this._pendingRequests.indexOf(ro), 1);
		req.abort('aborted');
	}
}

Crawler.prototype._waitForRequestsCompletion = function(){
	var requests = this._pendingRequests;
	var reqPerformed = false;
	return new Promise( (resolve, reject) => {
		var timeout = 1000 ;//_this.options.ajaxTimeout;

		var t = setInterval(function(){
			if(timeout <= 0 || requests.length == 0){
				clearInterval(t);
				//console.log("waitajax reoslve()")
				resolve(reqPerformed);
				return;
			}
			timeout -= 1;
			reqPerformed = true;
		}, 0);
	});
}

Crawler.prototype.initializePage = async function(page) {
	console.log('In initialize Page')
	var options = this.options,
	pageCookies = this.pageCookies;

	var crawler = this;
	// generate a static map of random values using a "static" seed for input fields
	// the same seed generates the same values
	// generated values MUST be the same for all analyze.js call othewise the same form will look different
	// for example if a page sends a form to itself with input=random1,
	// the same form on the same page (after first post) will became input=random2
	// => form.data1 != form.data2 => form.data2 is considered a different request and it'll be crawled.
	// this process will lead to and infinite loop!
	var inputValues = utils.generateRandomValues(this.options.randomSeed);



	crawler._page = page;
	//if(options.verbose)console.log("new page")
	await page.setRequestInterception(true);
	if(options.bypassCSP){
		await page.setBypassCSP(true);
	}

	// setTimeout(async function reqloop(){
	// 	for(let i = crawler._pendingRequests.length - 1; i >=0; i--){
	// 		let r = crawler._pendingRequests[i];
	// 		let events = {xhr: "xhrCompleted", fetch: "fetchCompleted"};
	// 		if(r.p.response()){
	// 			let rtxt = null;
	// 			try{
	// 				rtxt = await r.p.response().text();
	// 			} catch(e){}
	// 			await crawler.dispatchProbeEvent(events[r.h.type], {
	// 				request: r.h,
	// 				response: rtxt
	// 			});
	// 			crawler._pendingRequests.splice(i, 1);
	// 		}
	// 		if(r.p.failure()){
	// 			//console.log("*** FAILUREResponse for " + r.p.url())
	// 			crawler._pendingRequests.splice(i, 1);
	// 		}
	// 	}
	// 	setTimeout(reqloop, 50);
	// }, 50);

	page.on('request', async req => {
		// req.continue();
		// console.log(req.url())
		const isFromVimeoSubdomain = /^https?:\/\/([a-z0-9-]+\.)?vimeo\.com\//.test(req.url());
		if (!isFromVimeoSubdomain && req.method() != 'GET') {
			req.abort('aborted');
			return;
		}
		const overrides = {};
		if(req.isNavigationRequest() && req.frame() == page.mainFrame()){
			if(req.redirectChain().length > 0 && !crawler._allowNavigation){
				req.abort('aborted');
				return;
				// console.log('In redirect')
				// crawler._redirect = req.url();
				// console.log(crawler._redirect)
				// var uRet = await crawler.dispatchProbeEvent("redirect", {url: crawler._redirect});
				// if(!uRet){
				// 	console.log('abort')
				// 	req.abort('aborted'); // die silently
				// 	return;
				// }
				// if(options.exceptionOnRedirect){
				// 	console.log('except')
				// 	req.abort('aborted');
				// 	// req.abort('failed'); // throws exception
				// 	return;
				// }
				// req.continue();
				// return;
			}

			if(!crawler._firstRun){
				let r = new utils.Request("navigation", req.method() || "GET", req.url().split("#")[0], req.postData());
				await crawler.dispatchProbeEvent("navigation", {request:r});
				if (req.method() == 'POST') {
					// console.log('POST')
					await this.handleRequest(req);
					return;
				}

				if(crawler._allowNavigation){
					req.continue();
				} else {
					req.abort('aborted');
				}
				return;
			} else {
				if(options.loadWithPost){
					overrides.method = 'POST';
					if(options.postData){
						overrides.postData = options.postData;
					}
				}
			}

			crawler._firstRun = false;
		}
		// console.log(req.resourceType());
		if(req.resourceType() == 'xhr' || req.resourceType() == 'fetch' || req.resourceType() == 'navigation'){
			return await this.handleRequest(req);
		}
		req.continue(overrides);
	});


	page.on("dialog", function(dialog){
		dialog.accept();
	});

	// this._browser.on("targetcreated", async (target)=>{
	// 	const p = await target.page();
	// 	if(p) p.close();
	// });


	page.exposeFunction("__htcrawl_probe_event__",   (name, params) =>  {return this.dispatchProbeEvent(name, params)}); // <- automatically awaited.."If the puppeteerFunction returns a Promise, it will be awaited."

	page.exposeFunction("__htcrawl_set_trigger__", (val) => {crawler._trigger = val});

	page.exposeFunction("__htcrawl_wait_requests__", () => {return crawler._waitForRequestsCompletion()});

	await page.setViewport({
		width: 1366,
		height: 768,
	});
	console.log(probe.initProbe)
	console.log('Starting probe')
	page.evaluateOnNewDocument(probe.initProbe, this.options, inputValues);
	//page.evaluateOnNewDocument(probeTextComparator.initTextComparator);
	page.evaluateOnNewDocument(utils.initJs, this.options);


	try{
		if(options.referer){
			await page.setExtraHTTPHeaders({
				'Referer': options.referer
			});
		}
		if(options.extraHeaders){
			await page.setExtraHTTPHeaders(options.extraHeaders);
		}
		for(let i=0; i < options.setCookies.length; i++){
			if(!options.setCookies[i].expires)
				options.setCookies[i].expires = parseInt((new Date()).getTime() / 1000) + (60*60*24*365);
			//console.log(options.setCookies[i]);
			try{
				await page.setCookie(options.setCookies[i]);
			}catch (e){
				//console.log(e)
			}
		}

		if(options.httpAuth){
			await page.authenticate({username:options.httpAuth[0], password:options.httpAuth[1]});
		}

		if(options.userAgent){
			await page.setUserAgent(options.userAgent);
		}

		await this._page.setDefaultNavigationTimeout(this.options.navigationTimeout);

	}catch(e) {
		// do something  . . .
		console.log(e)
	}
	// return page;
	console.log('Finishing initialize Page')
};

Crawler.prototype.bootstrapPage = async function(){
	if (!this._page) {
		this._allowNewWindows = true;
		this._page = await this._browser.newPage();
		this._allowNewWindows = false;   
    }
    await this.initializePage(this._page);
}

Crawler.prototype.newPage = async function(url){
	if(url){
		this._setTargetUrl(url);
	}
	this._firstRun = true;
	await this.bootstrapPage();
}

Crawler.prototype.navigate = async function(url){  // @TODO test me ( see _firstRun)
	if(!this._loaded){
		throw("Crawler must be loaded before navigate");
	}
	var resp = null;
	try{
		resp = await this._goto(url);
	}catch(e){
		this._errors.push(["navigation","navigation aborted"]);
		throw("Navigation error");
	}

	await this._afterNavigation(resp);
};


Crawler.prototype.reload = async function(){
	if(!this._loaded){
		throw("Crawler must be loaded before navigate");
	}
	var resp = null;
	this._allowNavigation = true;
	try{
		resp = await this._page.reload({waitUntil:'load'});
	}catch(e){
		this._errors.push(["navigation","navigation aborted"]);
		throw("Navigation error");
	}finally{
		this._allowNavigation = false;
	}

	await this._afterNavigation(resp);

};


Crawler.prototype.clickToNavigate = async function(element, timeout){
	const _this = this;
	var pa;
	if(!this._loaded){
		throw("Crawler must be loaded before navigate");
	}
	if(typeof element == 'string'){
		try{
			element = await this._page.$(element);
		}catch(e){
			throw("Element not found")
		}
	}
	if(typeof timeout == 'undefined') timeout = 500;

	this._allowNavigation = true;
	// await this._page.evaluate(() => window.__PROBE__.DOMMutations=[]);

	try{
		pa = await Promise.all([
			element.click(),
			this._page.waitForRequest(req => req.isNavigationRequest() && req.frame() == _this._page.mainFrame(), {timeout:timeout}),
			this._page.waitForNavigation({waitUntil:'load'})
		]);

	} catch(e){
		pa = null;
	}
	this._allowNavigation = false;

	if(pa != null){
		await this._afterNavigation(pa[2]);
		return true;
	}
	_this._errors.push(["navigation","navigation aborted"]);
	throw("Navigation error");
};



Crawler.prototype.popMutation = async function(page){
	return await page.evaluateHandle(() => window.__PROBE__.popMutation())
}

Crawler.prototype.getFormRequest = async function(formElementHandle){
	return await this._page.evaluate(form => window.__PROBE__.triggerFormSubmitEvent(form), formElementHandle)
}

Crawler.prototype.getEventsForElement = async function(el, page) {
    const events = await page.evaluate(el => window.__PROBE__.getEventsForElement(el), el != this._page ? el : this.documentElement);
    const l = await this.getElementEventListeners(el);

    let allEvents = events.concat(l.listeners.map(i => i.type));
	// console.log(el.nodeName)
	allEvents = [...new Set(allEvents)];

    const nodeName = await page.evaluate(el => el.nodeName, el);
	// console.log(nodeName)

    if (nodeName && (nodeName.toLowerCase() === 'body' || nodeName.toLowerCase() === 'div')) {
        allEvents = allEvents.filter(eventType => eventType === 'click');
    }
	// console.log(allEvents)

    return allEvents;
}


/* DO NOT include node as first element.. this is a requirement */
Crawler.prototype.getDOMTreeAsArray = async function(node){
	var out = [];
	try{
		var children = await node.$$(":scope > *");
	}catch(e){
		return []
		//console.log("Evaluation failed: TypeError: element.querySelectorAll is not a function")
		//console.log(node)

	}

	if(children.length == 0){
		return out;
	}

	for(var a = 0; a < children.length; a++){
		out.push(children[a]);
		out = out.concat(await this.getDOMTreeAsArray(children[a]));
	}

	return out;
}





Crawler.prototype.isAttachedToDOM = async function(node, page){
	if(node == page){
		return true;
	}
	var p = node;
	while(p.asElement()) {
		let n = await (await p.getProperty('nodeName')).jsonValue();
		if(n.toLowerCase() == "html")
			return true;
		p = await p.getProperty('parentNode')//p.parentNode;
	}
	return false;
};

// Crawler.prototype.triggerElementEvent = async function(el, event){
// 	await this._page.evaluate((el, event) => {
// 		window.__PROBE__.triggerElementEvent(el, event)
// 	}, el != this._page ? el : this.documentElement, event)
// }

Crawler.prototype.triggerElementEvent = async function(selector, event, page) {
	
	if (page !== this._page) {
        const pages = await this._browser.pages();
        page = pages[2];
    }
    // Ensure the selector exists in the current context
    const elementExists = await page.$(selector);
	if (!elementExists) return;


	
	const isFormElement = await page.evaluate(selector => {
        const element = document.querySelector(selector);
        return element && (element.tagName.toLowerCase() === "form" || element.form) ? true : false;
    }, selector);


// 	if (isFormElement) {
// 		// Now, check for the form's existence on newPage
//         const formIdentifier = await page.evaluate(selector => {
//             const generateFormIdentifier = form => {
// 				return [
// 					form.tagName.toLowerCase(),
// 					form.getAttribute('name') || '',
// 					form.getAttribute('id') || '',
// 					form.getAttribute('action') || '',
// 					form.getAttribute('method') || '',
// 					...Array.from(form.classList).slice(0, 3)  // first 3 classes
// 				].join("|");
// 			};
		
// 			const element = document.querySelector(selector);
// 			const form = element.tagName.toLowerCase() === 'form' ? element : element.form;
// 			return generateFormIdentifier(form);
// 		}, selector);

//         if (this.submittedFormsSet.has(formIdentifier)) {
//             console.log(`Form already submitted: ${formIdentifier}`);
//             return;
//         }
//         this.submittedFormsSet.add(formIdentifier);
// 		if (!this.formQueue.includes(selector)) {
// 			this.formQueue.push(selector);
// 		}
// 		if (!this.formProcessingActive) {
// 			this.formProcessingActive = true;
// 			await this.processFormQueue();
// 		}
//         // // It's a form element; open a new tab
//         // // Check if the form has already been submitted
//         // const formIdentifier = await page.evaluate(selector => {
// 		// 	const generateFormIdentifier = form => {
// 		// 		return [
// 		// 			form.tagName.toLowerCase(),
// 		// 			form.getAttribute('name') || '',
// 		// 			form.getAttribute('id') || '',
// 		// 			form.getAttribute('action') || '',
// 		// 			form.getAttribute('method') || '',
// 		// 			...Array.from(form.classList).slice(0, 3)  // first 3 classes
// 		// 		].join("|");
// 		// 	};
		
// 		// 	const element = document.querySelector(selector);
// 		// 	const form = element.tagName.toLowerCase() === 'form' ? element : element.form;
// 		// 	return generateFormIdentifier(form);
// 		// }, selector);
// 		// console.log('FORM IDENTIFIER: ', formIdentifier)

//         // if (this.submittedFormsSet.has(formIdentifier)) {
//         //     console.log(`Form already submitted: ${formIdentifier}`);
//         //     return;
//         // }
//         // this.submittedFormsSet.add(formIdentifier);
        
		
        

//         // Optional: Close the new tab after processing
//     } else {
//         // It's not a form element; trigger the event in the current context
//         await page.evaluate((selector, event) => {
//             const element = document.querySelector(selector);
//             if (element) {
//                 window.__PROBE__.triggerElementEvent(element, event);
//             }
//         }, selector, event);
//     }
// }

    await this._page.evaluate((selector, event) => {
        const element = document.querySelector(selector);
        if (element) {
            window.__PROBE__.triggerElementEvent(element, event);
        }
    }, selector, event);
	// if (!elementExists) {
	// 	const frames = page.frames();
	// 	for (let frame of frames) {
	// 		const iframeElementExists = await frame.$(selector);
	// 		if (iframeElementExists) {
	// 			await this.triggerElementEvent(selector, event, frame);
	// 		}
	// 		else{
	// 			continue;
	// 		}
	// 	}
	// }
	
}

Crawler.prototype.getElementText = async function(el, page){
	if(el == this._page){
		return null;
	}
	return await page.evaluate(el => {
		if(el.tagName == "STYLE" || el.tagName == "SCRIPT"){
			return null;
		}
		// if (el.innerText) return el.innerText
	}, el);
}


// Crawler.prototype.fillInputValues = async function(el){
// 	await this._page.evaluate(el => {
// 		window.__PROBE__.fillInputValues(el);
// 	}, el != this._page ? el : this.documentElement)
// }


Crawler.prototype.fillInputValues = async function(target = this._page) {
	// console.log(target)
    // Determine if the target is a whole page
    const isPage = target === this._page || target.constructor.name === 'Page';
	// const isIframe = await target.evaluate(() => document.documentElement.tagName.toLowerCase() === 'iframe');
    // if (isIframe) {
    //     // Switch context to the iframe
    //     target = await target.contentFrame();
    // }
	// console.log(isPage)

    if (isPage) {
		try{
			await target.evaluate(() => {
				const docElement = document.documentElement;
				window.__PROBE__.fillInputValues(docElement);
			});
		}catch (e) {
			console.error('Error within fillInputValues:', e);
		}
        
    } else {  // If it's an element
        await target.evaluate((el) => {
            window.__PROBE__.fillInputValues(el);
        });
    }
}


Crawler.prototype.getElementSelector = async function(el,page){
	return await page.evaluate(el => {
		return window.__PROBE__.getElementSelector(el);
	}, el != this._page ? el : this.documentElement)
}

Crawler.prototype.nodeLookup = {};

// Load Element Tree
Crawler.prototype.loadElementTree = function() {
	try {
		if (fs.existsSync('elementTree.json')) {
			const tree = JSON.parse(fs.readFileSync('elementTree.json', 'utf-8'));
			
			// Populate the nodeLookup map
			tree.forEach(node => {
				this.nodeLookup[node.id] = node;
				this.nodeLookup[node.selector] = node;
			});

			return tree;
		}
	} catch (error) {
		console.error("Error loading element tree:", error);
	}
	return [];
};


// Save Element Tree
Crawler.prototype.saveElementTree = function(tree) {
	try {
		fs.writeFileSync('elementTree.json', JSON.stringify(tree));
	} catch (error) {
		console.error("Error saving element tree:", error);
	}
};

Crawler.prototype.findNodeInTree = function(idOrSelector) {
	return this.nodeLookup[idOrSelector] || null;
};

Crawler.prototype.initializeIdCounter = function(elementTree) {
	const maxId = elementTree.length > 0 ? Math.max(...elementTree.map(node => node.id)) : 0;
	this.idCounter = maxId + 1;
}

Crawler.prototype.addNodeToTree = function(selector, parentId, properties, elementTree) {
	if (typeof this.idCounter === 'undefined') {
		this.initializeIdCounter(elementTree);
	}
	const newNode = {
		id: this.idCounter++,  // Assign an ID
		selector: selector,
		parentId: parentId,
		...properties
	};
	elementTree.push(newNode);
	
	// Add the node to the nodeLookup map
	this.nodeLookup[newNode.id] = newNode;
	this.nodeLookup[newNode.selector] = newNode;

	return newNode;
};

Crawler.prototype.crawlDOM = async function(node, layer = 0) {
	if (this._stop) return;
	// try{
	// 	this._allowNewWindows = true;
	// 	let newPage = await this._browser.newPage();
	// 	this._allowNewWindows = false;
	// 	const currentURL = this._page.url();
	// 	await newPage.goto(currentURL);
	// 	await this.initializePage(newPage);
	// }catch(error) {
	// 	console.error("Error in getting selector:", error);
	// 	}
	node = node || this._page;
	const elementTree = this.loadElementTree();
	if (layer == this.options.maximumRecursion) return;

	const domArr = await this.getDOMTreeAsArray(node);
	const attributeAndInnerTexts = await Promise.all(domArr.map(el => el.evaluate(node => ({
		attributesString: [...node.attributes].map(attr => `${attr.name}=${attr.value}`).join("; "),
		innerText: node.innerText || ""
	}))));
	const domModificationsSet = new Set(this.domModifications); 


	let submitHintedElements = [];
	let otherElements = [];

	console.log(submitHintedElements.length);
	console.log(otherElements.length);
	const priorityList = [
		"log in", "log",  "submit", "login", "signin", "sign in",
		"register", "signup", "sign up", "join", "enroll",
		"proceed", "next", "confirm", "agree", "complete",
		"create account", "get started", "continue", "accept", "authorize"
	];

	// domArr.forEach((el, index) => {
	// 	const attributesString = attributeAndInnerTexts[index].attributesString.toLowerCase();
	// 	const innerText = attributeAndInnerTexts[index].innerText.toLowerCase();
		
	// 	if (priorityList.some(keyword => attributesString.includes(keyword) || innerText.includes(keyword))) {
	// 		submitHintedElements.push(el);
	// 	} else {
	// 		otherElements.push(el);
	// 	}
	// });
	for (let index = 0; index < domArr.length; index++) {
		const el = domArr[index];
		const attributesString = attributeAndInnerTexts[index].attributesString.toLowerCase();
		const innerText = attributeAndInnerTexts[index].innerText.toLowerCase();
	
		try {
			const elSelector = await this.getElementSelector(el, this._page);
	
			if (priorityList.some(keyword => attributesString.includes(keyword) || innerText.includes(keyword))) {
				submitHintedElements.push(elSelector);
			} else {
				otherElements.push(elSelector);
			}
		} catch (error) {
			console.error(`Error processing element at index ${index}:`, error);
		}
	}

	// for (let index = 0; index < domArr.length; index++) {
	// 	const el = domArr[index];
	// 	const attributesString = attributeAndInnerTexts[index].attributesString.toLowerCase();
	// 	const innerText = attributeAndInnerTexts[index].innerText.toLowerCase();
	
	// 	const elSelector = await this.getElementSelector(el, this._page);
	
	// 	if (priorityList.some(keyword => attributesString.includes(keyword) || innerText.includes(keyword))) {
	// 		submitHintedElements.push(elSelector);
	// 	} else {
	// 		otherElements.push(elSelector);
	// 	}
	// }

	const dom = [node, ...submitHintedElements, ...otherElements];
	console.log(submitHintedElements.length);
	console.log(otherElements.length);
	this._trigger = {};
	if (this.options.crawlmode == "random") {
		this.randomizeArray(domArr);
	}

	if (layer == 0) {
		await this.dispatchProbeEvent("start");
	}

	try{
		await this.fillInputValues(node);
	}
	catch (error) {
		console.error("Error in filling values:", error);
	}
	let nodesel
	try{
		nodesel = await this.getElementSelector(node, this._page);
		// console.log(nodesel)
	}catch(error) {
		console.error("Error in getting selector:", error);
		}
	
	for (let elsel of dom) {
		try {
			const pages = await this._browser.pages();
			this._page = pages[1];
		} catch (error) {
			console.error("Page is no longer valid:", error);
		}
		
		let el;
		if (elsel && typeof elsel.asElement === 'function') {
			el = elsel;
			elsel = await this.getElementSelector(el, this._page);
		} else {
			if (elsel == "") continue;
			try {
				el = await this._page.$(elsel);
			} catch (error) {
				console.error(`Error while querying selector "${elsel}":`, error);
			}
			// el = await this._page.$(elsel);
			// console.log(el)
		}
		let isIframe = await el.evaluate(node => {
			return node && node.tagName && (node.tagName.toLowerCase() === 'iframe');
		});
		if (isIframe) {
			console.log('FOUND Iframe in ', elsel);
			try {
				let iframe = await el.contentFrame();
				const iframeHTML = await iframe.evaluate(() => document.documentElement.outerHTML);
				console.log(iframeHTML); // Log the HTML content
				// await this.crawlDOM(iframe, layer + 1);
			} catch (error) {
				console.error("Error accessing iframe content:", error);
			}
		}
		let isButton = await el.evaluate(node => {
			return node && node.tagName && (node.tagName.toLowerCase() === 'button');
		});
		// if (!isButton) continue;
		console.log(elsel)

		if (this._stop) return;
		try {
			const [isAttached, eventsForElement] = await Promise.all([
			    this.isAttachedToDOM(el, this._page),
			    this.getEventsForElement(el, this._page)
			]);
			// if (elsel != '.sc-1ekvrxa-17.dQMxbR') continue;
			if (layer > 0) console.log("Layer>0 elsel: ", elsel)
			let currentNode = this.findNodeInTree(elsel, elementTree);
			if (currentNode && currentNode.traversed) {
				console.log("Node traversed already: "+elsel);
				continue;
			}
		
			if (!currentNode) {
				let parentId = null;
				if (node) {  
					let parentNode = this.findNodeInTree(nodesel, elementTree);
					parentId = parentNode ? parentNode.id : null;
				}
				currentNode = this.addNodeToTree(elsel, parentId, { trigger: this._trigger, layer: layer, traversed: false }, elementTree);
			}
			// console.log(currentNode)

			if (!isAttached) {
				const uRetEarly = await this.dispatchProbeEvent("earlydetach", { node: elsel });
				if (!uRetEarly) continue;
			}

			for (let event of eventsForElement) {
				if (this._stop) return;
				await this.fillInputValues(el);
				if (this.options.triggerEvents) {
					// let isButton = await el.evaluate(node => {
					// 	return node && node.tagName && node.tagName.toLowerCase() === 'button';
					// });
					
					let sleepDuration = TRIGGER_SLEEP;
					if (isButton) {
						sleepDuration *= 10;
						console.log('ELSEL:', elsel);
					}
					console.log(elsel)
					console.log(event)
					await new Promise(resolve => setTimeout(resolve, sleepDuration));

					const uRetTrigger = await this.dispatchProbeEvent("triggerevent", { node: elsel, event: event });
					if (!uRetTrigger) continue;

					await this.triggerElementEvent(elsel, event, this._page);
					// console.log("eventtriggered");
					await this.dispatchProbeEvent("eventtriggered", { node: elsel, event: event });
				}
				el = await this._page.$(elsel);
				await this.waitForRequestsCompletion(this._page);

				const newEls = [];
				// console.log('Waiting for pop')
				let newRoot = await this.popMutation(this._page);
				console.log('newRoot: ',newRoot)
				while (newRoot.asElement()) {
					newEls.push(newRoot);
					newRoot = await this.popMutation(this._page);
					console.log('newRoot as elem: ',newRoot)
				}

				console.log(newEls.length)
				// const elementTexts = await Promise.all(newEls.map(e => this.getElementText(e, this._page)));
				for (let i = newEls.length - 1; i >= 0; i--) {
					let tosplice = false;
					let el = newEls[i]
					console.log(el)
					if(el == this._page){
						tosplice = true;
					}
					const nodeName = await this._page.evaluate(el => el.nodeName, el);

    				if (nodeName && (nodeName.toLowerCase() === 'style' || nodeName.toLowerCase() === 'script')){
						tosplice = true;
					}
					if (tosplice) {
						newEls.splice(i, 1);
					}
				}
				console.log(newEls.length)
				if (newEls.length > 0) {
					// if (this.options.skipDuplicateContent) {
					// 	for (const newText of elementTexts) {
					// 		if (newText) {
					// 			domModificationsSet.add(newText);
					// 		}
					// 	}
					// }

					if (this.options.crawlmode == "random") {
						this.randomizeArray(newEls);
					}

					await Promise.all(newEls.map(ne => this.fillInputValues(ne)));

					for (let ne of newEls) {
						if (this._stop) return;
						const neSelector = await this.getElementSelector(ne, this._page);
						console.log(neSelector)
						if (neSelector && neSelector.trim() !== "") {
							console.log(neSelector)
							console.log('Adding to tree')
							if (!this.findNodeInTree(neSelector, elementTree)) {
								this.addNodeToTree(neSelector, currentNode.id, {
									trigger: this._trigger,
									layer: layer + 1,
									traversed: false
								}, elementTree);
							}
							console.log('Added')
							console.log(neSelector)
							console.log(this._trigger)
							console.log(layer)
							const uRet = await this.dispatchProbeEvent("newdom", {
								rootNode: neSelector,
								trigger: this._trigger,
								layer: layer
							});
							console.log('Starting new')
							await new Promise(resolve => setTimeout(resolve, 10000));
							if (uRet) await this.crawlDOM(ne, layer + 1);
							
						}
					}
				}
			}

			const elementIndex = elementTree.findIndex(e => e.selector === elsel);
			if (elementIndex !== -1) {
				elementTree[elementIndex].traversed = true;
			}
			this.saveElementTree(elementTree);

		} catch (error) {
			console.error("Error in crawlDOM loop:", error.message);
		}
	}

	this.domModifications = [...domModificationsSet]; // Convert the Set back to an array for storage
};

Crawler.prototype.isElementAccessible = async function(selector) {
    const el = await this._page.$(selector);
    return !!el;
}

Crawler.prototype.getTriggerSequence = async function(selector) {
    let sequence = [];
    let node = this.findNodeInTree(selector);

    // Check if the form is directly accessible
    if (await this.isElementAccessible(selector)) {
        return sequence;  // return empty sequence since the form is directly accessible
    }

    while (node) {
        if (node.trigger) {
            sequence.unshift(node.trigger);  // Add the trigger to the beginning of the sequence
            if (await this.isElementAccessible(node.trigger.element)) {
                break;  // If the trigger's element is accessible, break the loop
            }
        }
        node = this.findNodeInTree(node.parentId);
    }
    return sequence;
}

Crawler.prototype.formProcessingActive = false;


Crawler.prototype.processFormQueue = async function() {
    // while (this.formQueue.length > 0) {
        const selector = this.formQueue.shift(); // Get the first form
		if (selector) {
			const triggerSequence = await this.getTriggerSequence(selector);
			await this.submitForm(selector, triggerSequence);
		}
		this.formProcessingActive = false;
    // }
}

Crawler.prototype.submitForm = async function(selector, triggerSequence) {
	console.log('SELECTOR: ',selector)
	console.log('TRIGGER SEQUENCE: ', triggerSequence)
    try {
        this._allowNewWindows = true;
        let newPage = await this._browser.newPage();
        const currentURL = this._page.url();

        this._allowNavigation = true;
        await this.initializePage(newPage);
        await Promise.all([
            newPage.goto(currentURL),
            newPage.waitForNavigation({ waitUntil: 'load' })
        ]);

        for (let trigger of triggerSequence) {
            // Trigger each event in the sequence on the new page
            await this.triggerElementEvent(trigger.element, trigger.event, newPage);
        }

        await new Promise(resolve => setTimeout(resolve, 15000));
		let probeObject = await newPage.evaluate(() => {
			return window.__PROBE__;
		});
		await new Promise(resolve => setTimeout(resolve, 5000));
		console.log('Probe object in newPage:', probeObject);
		console.log('Start filling')
		await this.fillInputValues(newPage);
		console.log('Stop filling')
		this._allowNewWindows = false;
		console.log('Hello');
		await new Promise(resolve => setTimeout(resolve, 5000));
		console.log('Selector: ',selector);
		

		// Trigger the event on the new tab
		await newPage.evaluate((selector) => {
			const formElement = document.querySelector(selector);
			if (formElement && formElement.tagName.toLowerCase() === 'form') {
				formElement.submit();
			}
		}, selector);
		this._allowNavigation = false;

        await newPage.close(); 
    } catch (error) {
        console.error("Error processing form element:", error);
    } 
	finally {
        if (newPage && !newPage.isClosed()) {
            await newPage.close();
        }
    }
}

// Crawler.prototype.processFormQueue = async function() {
//     // while (this.formQueue.length > 0) {
// 		let selector
//         selector = this.formQueue.shift(); // Get the first form
// 		console.log('SELECTOR: ',selector)
//         const triggerSequence = await this.getTriggerSequence(selector);
// 		console.log('TRIGGER SEQUENCE: ', triggerSequence)

//         for (let trigger of triggerSequence) {
//             // Here we'll trigger each event in the sequence
//             await this.triggerElementEvent(trigger.element, trigger.event, this._page);
//         }

// 		const formIdentifier = await page.evaluate(selector => {
// 			const generateFormIdentifier = form => {
// 				return [
// 					form.tagName.toLowerCase(),
// 					form.getAttribute('name') || '',
// 					form.getAttribute('id') || '',
// 					form.getAttribute('action') || '',
// 					form.getAttribute('method') || '',
// 					...Array.from(form.classList).slice(0, 3)  // first 3 classes
// 				].join("|");
// 			};
		
// 			const element = document.querySelector(selector);
// 			const form = element.tagName.toLowerCase() === 'form' ? element : element.form;
// 			return generateFormIdentifier(form);
// 		}, selector);

// 		console.log('FORM IDENTIFIER: ', formIdentifier)

//         if (this.submittedFormsSet.has(formIdentifier)) {
//             console.log(`Form already submitted: ${formIdentifier}`);
//             return;
//         }
//         this.submittedFormsSet.add(formIdentifier);

// 		try{
// 			this._allowNewWindows = true;
// 			let newPage = await this._browser.newPage();
// 			const currentURL = this._page.url();
// 			// newPage.on('error', err => {
// 			// 	console.log("Page Error:", err);
// 			//  });
			 
// 			//  newPage.on('pageerror', err => {
// 			// 	console.log("Page JavaScript Error:", err);
// 			//  });
			 
// 			//  newPage.on('console', msg => {
// 			// 	console.log("Console Log:", msg.text());
// 			//  });
// 			this._allowNavigation = true;
// 			await this.initializePage(newPage);
// 			await Promise.all([
// 				newPage.goto(currentURL),
// 				newPage.waitForNavigation({ waitUntil: 'load' })
// 			]);
// 			// await newPage.goto(currentURL);
// 			// await newPage.waitForNavigation({ waitUntil: 'domcontentloaded' });
// 			// await new Promise(resolve => setTimeout(resolve, 15000));
// 			// await this.initializePage(newPage);
			
// 			//await newPage.addScriptTag({ path: './probe.js' });
// 			await new Promise(resolve => setTimeout(resolve, 15000));
// 			let probeObject = await newPage.evaluate(() => {
// 				return window.__PROBE__;
// 			});
// 			await new Promise(resolve => setTimeout(resolve, 5000));
// 			console.log('Probe object in newPage:', probeObject);
// 			console.log('Start filling')
// 			await this.fillInputValues(newPage);
// 			console.log('Stop filling')
// 			this._allowNewWindows = false;
// 			console.log('Hello');
// 			await new Promise(resolve => setTimeout(resolve, 5000));
// 			console.log('Selector: ',selector);
			

// 			// Trigger the event on the new tab
// 			await newPage.evaluate((selector) => {
// 				const formElement = document.querySelector(selector);
// 				if (formElement && formElement.tagName.toLowerCase() === 'form') {
// 					formElement.submit();
// 				}
// 			}, selector);
// 			this._allowNavigation = false;
// 			await newPage.close();
// 		}catch (error) {
// 			console.error("Error processing form element: ", error);
// 		}
//         // At this point, the form should be available in the DOM
//         // You can then fill the form and submit it or perform other tasks.
//     // }
// }

Crawler.prototype.getElementRemoteId = async function(el){
	if(el == this._page){
		el = this.documentElement;
	}
	const node = await this._page._client().send("DOM.describeNode", {
		objectId: el.remoteObject().objectId
	});
	return node.node.backendNodeId;
}


Crawler.prototype.getElementEventListeners = async function(el){
	if(el == this._page){
		el = this.documentElement;
	}
	//try{
	const node = await this._page._client().send("DOMDebugger.getEventListeners", {
		objectId: el.remoteObject().objectId
	});
	//}catch(e){console.log(el)}

	return node;
}


Crawler.prototype.randomizeArray = function(arr) {
	var a, ri;
	for (a = arr.length - 1; a > 0; a--) {
		ri = Math.floor(Math.random() * (a + 1));
		[arr[a], arr[ri]] = [arr[ri], arr[a]];
	}
};

