// spotify
var sp= getSpotifyApi(1),
  models= sp.require("sp://import/scripts/api/models"),
  player= models.player

// requires
var nd5= sp.require("lib/nd5").md5,
  auth= sp.require("auth")

// consts
var SETTINGS= ["run", "spotted", "user", "pw", "server"],
  SETTING_VALUE= "value",
  SETTING_CHECK= "checked",
  SETTING_SLOT= [SETTING_CHECK, SETTING_CHECK, SETTING_VALUE, SETTING_VALUE, SETTING_VALUE],
  WAIT_DURATION= 6*1000,
  WAIT_STANDOFF= 600

exports.init = init

// globals 
var lastSession= null,
  wait= null

// startup
function init(){
	console.log("init")
	//wipeSettings() // debug only!
	restoreSettings()
	bindSettings()
	//fetchLastFmSession()
	scrobbleWatcher()
}

/**
* retrieve a configuration object of all settings from localStorage
*/
function fetchSettings(){
	var cfg= {}
	for(var i in SETTINGS){
		var setting= SETTINGS[i],
		  val= localStorage.getItem(setting) // lords above & below, forgive me: this had been IndexedDB, but the M17 chrome in Spotify used the old setVersion stuff & "this," loathsome this, was easier than rewriting that.
		if(val === undefined || val === null)
			continue

		val= JSON.parse(val)
		cfg[setting]= val
	}
	return cfg
}

function fetchSetting(item){
	if(isNaN(item)){
		for(var i in SETTINGS){
			if(SETTINGS[i] == item){
				item= i
				break
			}
		}
		if(isNaN(item)){
			console.error("could not find setting",item)
			return {}
		}
	}
	var setting= SETTINGS[item],
	  val= localStorage.getItem(setting)
	if(val === undefined || val === null)
		return null
	return JSON.parse(val)
}

/**
* clear all settings stored in localStorage
*/
function wipeSettings(){
	for(var i in SETTINGS){
		localStorage.removeItem(SETTINGS[i])
	}
}

/**
* apply a settings object to controls on the page
*/
function restoreSettings(){
	var settings= fetchSettings()
	for(var i in SETTINGS){
		var setting= SETTINGS[i],
		  slot= SETTING_SLOT[i],
		  el= document.getElementById(setting),
		  val= settings[setting]
		if(val === undefined)
			continue
		console.log("setting",el,"."+slot,"to",val)
		el[slot]= val
	}
}

/**
* build event handlers for input elements to save themselves into localStorage
*/
function bindSettings(){
	function makeUpdateHandler(i){
		return function(e){
			// clear our last.fm session
			lastSession= null

			// save in localStorage
			var slot= SETTING_SLOT[i],
			  val= JSON.stringify(this[slot])
			console.log("setting changed",this.id+"."+slot,val,i)
			localStorage.setItem(this.id,val)
		}
	}

	for(var i in SETTINGS){
		// bind a handler to each form element
		var setting= SETTINGS[i],
		  el= document.getElementById(setting),
		  handler= makeUpdateHandler(i)
		el.onchange= handler
		el.onkeyup= handler

		// initialize localStorage if this is our first run
		handler.call(el)
	}
}

/**
* build a watcher will will look for track changes
*/
function scrobbleWatcher(){
	player.observe(models.EVENT.CHANGE, function(e){
		// track change event
		if(e.data.curtrack == true){
			// capture the track
			var track= player.track,
			  // timestamp,
			  timestamp= epoch(),
			  // wait to make sure the user listens for the requisite amount of time
			  waitTime= (track.duration < WAIT_DURATION? track.duration: WAIT_DURATION)
			if(waitTime > 2 * WAIT_STANDOFF)
				waitTime -= WAIT_STANDOFF
			if(wait){
				console.log("bypassing timeout")
				clearTimeout(wait)
			}
			console.log("track changed",e,player,track.uri,track.name,track.artists[0].uri,track.album.uri,waitTime)
			if(track.duration < 30000){
				return
			}
			wait= setTimeout(function(){
				fetchLastFmSession(function(sk){
					// we've waited, now scrobbling
					var trackParams= trackToScrobble(track,timestamp),
					  params= paramitize({method:"track.scrobble", sk:sk, api_key:auth.key}, trackParams)
					xhrLastFm("POST",params,function(xhr){
						console.log("posted scrobble",params,xhr)
					},function(){
						console.log("failed scrobble",params)
					})
				})
			},waitTime)
		}
	})
}

/**
* calculate a unix epoch
*/
function epoch(){
	return Math.round((new Date()).getTime() / 1000)
}

/**
* convert a spotify track into scrobble params
*/
function trackToScrobble(track,timestamp){
	/*
	var params= {
		artist: track.album.artist.name,
		track: track.name,
		timestamp: timestamp
	}
	return params
	*/

	// basic parameters
	var params= {
		artist: textPurify(track.album.artist.name),
		track: textPurify(track.name),
		timestamp: timestamp,
		album: textPurify(track.album.name),
		trackNumber: track.number,
		duration: Math.round(track.duration/1000)
	}

	// extended parameters
	if(fetchSetting("spotted")){
		params.artistUri= track.album.artist.uri
		params.trackUri= track.uri
		params.albumUri= track.album.uri
		params.spotifyUserId= models.session.anonymousUserID
	}

	return params
}

/**
* get a mobile auth token for last.fm
*/
function fetchLastFmSession(callback){
	if(lastSession){
		callback(lastSession)
		return
	}

	var cfg= fetchSettings(),
	  authToken= nd5(cfg.user + nd5(cfg.pw))
	  params= paramitize({method:"auth.getMobileSession",api_key:auth.key},{username:cfg.user,authToken:authToken},{format:"json"})
	xhrLastFm("POST",params,function(xhr){
		var response= JSON.parse(xhr.responseText)
		if(!response.session || !response.session.key){
			callback()
			return
		}
		lastSession= response.session.key
		console.log("got session key",lastSession,response.session,xhr)
		callback(lastSession)
	},function(){
		callback()
	},"https://ws.audioscrobbler.com/2.0/")
}

/**
* helper for making last.fm calls
*/
function xhrLastFm(method,params,callback,err,server){
	var xhr= new XMLHttpRequest(),
	  server= server||fetchSetting("server")

	xhr.open(method,server,true)
	xhr.setRequestHeader("Content-Type","application/x-www-form-urlencoded")
	xhr.onreadystatechange= function(){
		if(xhr.readyState != 4){
			return
		}
		if(xhr.status != 200){
			console.error("last.fm xhr bad status",xhr.status,xhr)
			err(xhr)
			return
		}
		callback(xhr)
	}
	xhr.send(params)
}

/**
* last.fm is a little demanding, it wants some api_sig stuff: pass in param fragments.
*/
function paramitize(fragments__){
	var composite= {},
	  keys= []
	for(var i in arguments){
		var arg= arguments[i]
		for(var j in arg){
			composite[j]= arg[j]
			if(keys.indexOf(j) == -1)
				keys.push(j)
		}
	}
	keys.sort()

	var param= "",
	  sig= ""
	for(var i in keys){
		var key= keys[i],
		  val= composite[key]
		if(key != "callback" && key != "format"){
			sig+= key+val
		}
		param+= (i==0?"":"&")+key+"="+val
	}
	sig+= auth.secret
	console.log("sig",sig)
	param+= "&api_sig="+nd5(sig)
	return param
}

var elPurifier= document.getElementById("textPurifier")
function textPurify(impure){
	if(impure.decodeForText){
		return impure.decodeForText()
	}
	elPurifier.innerHTML= impure
	return elPurifier.innerText
}
