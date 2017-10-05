"use strict";

var fs = require('fs');
var Discord = require('discord.js');
var request = require('request');
var websocket = require('ws');
var settingsFile = process.argv.slice(2).join(" ") || "settings.json";
var settings = JSON.parse(fs.readFileSync(settingsFile,"utf-8"));


var client = new Discord.Client({
	autoReconnect: true
});



const invitelink = 'https://discordapp.com/oauth2/authorize?client_id=' + settings.discord.client_id + '&scope=bot&permissions=3072';

// discord bot
client.on('ready', function () {
	console.log("Ready");
	initPubSub();
});

client.on('message', function (message) {
	console.log("Received discord message: "+message.author.username+": "+message.cleanContent);
	if(settings.discord.admins.indexOf(message.author.id) >= 0) {
		if(message.cleanContent.startsWith(settings.discord.prefix)) {
			let words = message.cleanContent.substring(settings.discord.prefix.length).match(/(?:[^\s"]+|"[^"]*")+/g);
			if (words) {
				let cmd = words[0];
				if (commands[cmd]) {
					words.shift();
					console.log("Received command "+message.cleanContent);
					commands[cmd](message.channel, message, words);
				}
			}
		}
	}
});

client.on('warn', function (warn) {
    console.error('WARN', warn);
});

client.on('error', function (error) {
    console.error('ERROR', error);
});

client.login(settings.discord.token);

var knownChannels = {};
function getChannelID(channelname, callback) {
	if(knownChannels[channelname]) {
		callback(null, knownChannels[channelname]);
		return;
	}
	request.get({
		url: "https://api.twitch.tv/kraken/channels/"+channelname+"?client_id="+settings.twitch.client_id
	},function(e,r,body){
		if(e) {
			console.error(e);
			callback(e);
		} else if(body === undefined) {
			console.error("Error: "+r.statusCode);
			callback("Error: "+r.statusCode);
		} else {
			try {
				var id = JSON.parse(body)._id;
				knownChannels[channelname] = id;
				callback(null, id);
			} catch(e) {
				console.error("Error: "+e+" in getChannelID("+channelname+").");
				if(callback) callback(e);
			}
		}
	}, function(error){
		console.error("Couldnt load "+channelname+"'s channel ID.\nError: "+error);
		if(callback) callback(error);
	});
}

var commands = {
    help: function (channel, message, words) {
        sendReply(message, "command prefix: " + settings.discord.prefix + " - commands: " + Object.keys(commands).join(', '));
    },
    invite: function(channel, message, words) {
        sendReply(message, "Bot invite link: "+invitelink+" - make sure user `"+settings.twitch.mod.name+"` is modded in the target channel");
    },
	listen: function(channel, message, words) {
		if(words.length == 1) {
			console.log("Got command to listen to twitch channel "+words[0]+" in discord channel "+channel.id+".");
			var twitchChannel = words[0].toLowerCase();
			getChannelID(twitchChannel, function(error, id) {
				if(error || !id) {
					message.reply("An error occurred processing your request: "+(error || "no id returned o.O"));
					return;
				}
				var listener = {
					"twitch": {
						"channel_id": ""+id,
						"channel_name": twitchChannel
					},
					"discord": {
						"channel_id": channel.id
					}
				}
				if(listen(listener)) {
					message.reply("Now listening to mod logs for channel "+twitchChannel);
					// save the listener
					settings.listeners.push(listener);
					saveSettings();
				} else {
					message.reply("Already listening to mod logs from channel "+twitchChannel+" in this channel.");
				}
			});
		} else {
			message.reply("Usage: `"+settings.discord.prefix+"listen <channel>`");
		}
	},
	unlisten: function(channel, message, words) {
		var listeners = [];
		var channels = [];
		if(words.length == 0) {
			var listeners = discordChannelId2Listeners[channel.id];
			for(var i=0;i<listeners.length;++i) {
				// unlisten this listener
				channels.push(unlisten(listeners[i]));
			}
			saveSettings();
		} else {
			for(var i=0;i<words.length;++i) {
				var twitchChannel = words[i].toLowerCase();
				getChannelID(twitchChannel, function(error, id) {
					var listeners = [].concat(twitchChannelId2Listeners[id]);
					for(var i=0;i<listeners.length;++i) {
						var listener = listeners[i];
						if(listener.discord.channel_id == channel.id) {
							// unlisten this listener
							channels.push(unlisten(listener));
						}
					}
					saveSettings();
					console.log("Got command to unlisten from twitch channel "+words[0]+" in discord channel "+channel.id+" - "+listeners.length+" listeners");
				});
			}
		}
		if(channels.length > 0) message.reply("No longer listening to mod logs from channel(s) "+channels.join(", "));
		else message.reply("Not listening to mod logs from  any channel");
	},
	list: function(channel, message, words) {
		// get listeners for this discord channel
		var listeners = discordChannelId2Listeners[channel.id] || [];
		var listenernames = [];
		for(var i=0;i<listeners.length;++i) {
			var listener = listeners[i];
			listenernames.push(listener.twitch.channel_name);
		}
		var reply;
		if(listenernames.length > 0) {
			reply = "Listening for mod logs for the channels "+listenernames.join(", ");
		}
		else reply = "Not listening for any mod logs in here.";
		message.reply(reply);
	},
	imp: function(channel, message, words) {
		if(words.length < 2 || !/^\d+$/.test(words[0])) {
			message.reply("Usage: "+settings.discord.prefix+"imp <channel id> <command>")
		}
		var otherchannel = client.channels.get(words[0]);
		var command = commands[words[1].match(/\b\w+$/)[0]];
		if(channel && command) {
			console.log("imping command "+words[1]+" in channel:")
			console.log(channel);
			command(otherchannel, message, words.slice(2));
		} else {
			if(!channel) message.reply("Channel not found.");
			if(!command) message.reply("Command not found.");
		}
	}
};

function sendReply(message, reply) {
    message.reply(reply, { tts: false }, function (error) {
        if (error) {
            console.error('WERROR', error);
        }
    });
}

function saveSettings() {
	fs.writeFile(settingsFile, JSON.stringify(settings, null, 4), (err)=>{
		if(err) console.error(err);
	});
}

var pubsub;
var twitchChannelId2Listeners = {};
var discordChannelId2Listeners = {};
function listen(listener) {
	// check if we are already listening to this twitch channel in this discord channel.
	var twitch_id = listener.twitch.channel_id;
	var discord_id = listener.discord.channel_id;
	var existinglisteners = discordChannelId2Listeners[discord_id];
	if(existinglisteners) {
		for(var i=0;i<existinglisteners.length;++i) {
			if(existinglisteners[i].twitch.channel_id == listener.twitch.channel_id) {
				return false;
			}
		}
	}
	
	if(twitchChannelId2Listeners[twitch_id]) {
		console.log("Adding a listener for channel  "+listener.twitch.channel_name+" (ID "+listener.twitch.channel_id+") for discord channel "+listener.discord.channel_id);
		twitchChannelId2Listeners[twitch_id].push(listener);
	}
	else {
		// we havent had this channel before, listen to it.
		console.log("Listening to mod logs from channel "+listener.twitch.channel_name+" (ID "+listener.twitch.channel_id+")");
		var command = JSON.stringify({"type":"LISTEN","data":{"topics":["chat_moderator_actions."+settings.twitch.mod.id+"."+listener.twitch.channel_id], "auth_token": settings.twitch.mod.oauth}});
		console.log("Sending command on pubsub: "+command);
		pubsub.send(command);
		twitchChannelId2Listeners[twitch_id] = [listener];
	}
	if(!discordChannelId2Listeners[discord_id]) {
		discordChannelId2Listeners[discord_id] = [listener];
	} else {
		discordChannelId2Listeners[discord_id].push(listener);
	}
	return true;
}

function removeFromList(list, item) {
	var index = list.indexOf(item);
	if(index >= 0) {
		list.splice(index,1);
	}
}

function unlisten(listener) {
	var twitch_id = listener.twitch.channel_id;
	if(twitchChannelId2Listeners[twitch_id]) {
		removeFromList(twitchChannelId2Listeners[twitch_id], listener);
	}
	var discord_id = listener.discord.channel_id;
	if(discordChannelId2Listeners[discord_id]) {
		removeFromList(discordChannelId2Listeners[discord_id], listener);
	}
	removeFromList(settings.listeners, listener);
	return listener.twitch.channel_name;
}

function initPubSub(){
	console.log("Initializing pubsub");
	pubsub = new websocket(settings.twitch.pubsub_server);
	// twitch pubsub stuff
	pubsub.on("open", function() {
		console.log("PubSub connected");
		for(var i=0;i<settings.listeners.length;++i) {
			listen(settings.listeners[i]);
		}
		setInterval(function(){
			pubsub.send(JSON.stringify({type: "PING"}));
		}, 60*1000);
	});

	pubsub.on("message", function(data) {
		var msg = JSON.parse(data);
		console.log("Pubsub received message: "+JSON.stringify(msg));
		
		// send the message to all channels if it was a chat mod action
		if(msg.type == "MESSAGE") {
			var topicsplit = msg.data.topic.split(".");
			var type = topicsplit[0];
			if(type == "chat_moderator_actions") {
				var action = JSON.parse(msg.data.message).data;
				var listeners = twitchChannelId2Listeners[topicsplit[2]];
				console.log("Got a channel modlog for channel "+topicsplit[2] + " for "+listeners.length+" listeners");
				if(settings.twitch.ignored.users.indexOf(action.created_by) >= 0 && settings.twitch.ignored.actions.indexOf(action.moderation_action) >= 0) {
					return;
				}
				for(var i=0;i<listeners.length;++i) {
					var listener = listeners[i];
					var text = action.created_by+" used command `/"+action.moderation_action+(action.args?" "+action.args.join(" "):"")+"`";
					var listenersForThisDiscordChannel = discordChannelId2Listeners[listener.discord.channel_id];
					var discordchannel = client.channels.find("id", listener.discord.channel_id);
					if(listenersForThisDiscordChannel.length > 1) text += " in channel "+listener.twitch.channel_name;
					if(action.moderation_action == "timeout" || action.moderation_action == "ban" || action.moderation_action == "unban" || action.moderation_action == "untimeout") {
					if(action.moderation_action == "unban") {
							var url = "https://api.twitch.tv/kraken/users/" + action.target_user_id + "?api_version=5&client_id=" + settings.twitch.client_id;
							request({
    							url: url,
   								json: true
							}, function (error, response, body) {
    							if (!error && response.statusCode === 200) {
       								if(discordchannel) {
										discordchannel.sendMessage(action.created_by+" used command `/"+action.moderation_action+ " " + body.name +"`\nSee https://cbenni.com/"+listener.twitch.channel_name+"/?user="+body.name);
									} else {
										console.error("Could not find discord channel for listener "+JSON.stringify(listener));
									}
    							}
							}
					)} else {
					    text += "\nSee https://cbenni.com/"+listener.twitch.channel_name+"/?user="+action.args[0];
					    if(discordchannel) {
						discordchannel.sendMessage(text);
					} else {
						console.error("Could not find discord channel for listener "+JSON.stringify(listener));
					}
					}}
				}
			}
		}
		
	});
}
