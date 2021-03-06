'use strict';

var bodyParser = require("body-parser"),
	aws = require("./awsClient.js"),
	validator = require("./validator.js"),
	getIP = require('external-ip')();

// Sets up express server to accept HTTP 
var app = require("express")();
var http = require("http").Server(app);
var io = require('socket.io')(http);

var clientDir = "/public"

http.listen(8888, function() {
	console.log("HTTP server listening on port 8888");
});

// Serve up the index.html file as the home page
app.get("/", function (req, res) {
	res.sendFile(__dirname + clientDir + '/index.html');
});

// Serve up all other files through the public directory
app.get("/:fileName", function (req, res) {
	res.sendFile(__dirname + clientDir + "/" + req.params.fileName);
});

app.get("/:directory/:fileName", function(req, res) {
	res.sendFile(__dirname + clientDir + "/" + req.params.directory + "/" + req.params.fileName);
});

// Get the public IP address of the Node server
var externalIP = "";
getIP(function (err, ip) {
	if (err) {
		throw err;
	}
	externalIP = ip;
	console.log("The server's IP address is " + externalIP);
});

// An array of active room IDs
var activeRooms = [];

// This function is called by the array of rooms - returns -1 if the room ID is not found - returns the index of the room in the array if the room ID is found
activeRooms.roomIndexByID = function(targetID) {
	var resIndex = -1;
	for (var i = 0; i < this.length; i++) {
		if (targetID === this[i].id)
			resIndex = i;
	}
	return resIndex;
}

// This function is called by the array of rooms - the user list of each room is checked for the user with the socket ID string specified by the paramater, and this user is deleted from the room's user list
activeRooms.deleteUserBySocketID = function(socketID) {
	for (var roomInd = 0; roomInd < this.length; roomInd++) {
		for (var userInd = 0; userInd < this[roomInd].userList.length; userInd++) {
			if (this[roomInd].userList[userInd].socketID === socketID) {
				this[roomInd].userList.splice(userInd, 1);
				// Return the room ID if the user was found
				return this[roomInd].id;
			}
		}
	}
	// If the user was not found, return undefined
	return undefined;
}

// Toggles the handRaised value of the user in room roomID and with a socketID of socketID
activeRooms.toggleHand = function(roomID, socketID) {
	for (var roomInd = 0; roomInd < this.length; roomInd++) {
		if (roomID === this[roomInd].id) {
			for (var userInd = 0; userInd < this[roomInd].userList.length; userInd++) {
				var user = this[roomInd].userList[userInd];
				if (user.socketID === socketID) {
					user.handRaised ? user.handRaised = false : user.handRaised = true;
					// Returns the room's index in the array if the user was found and the handRaise value was toggled
					return roomInd;
				}
			}
		}
	}
	// Returns undefined if the user could not be found and the hand was not toggled
	return undefined;
}

// This route takes the user to the room
app.get("/room/:userType/:roomID", function (req, res) {
	// The user type is p if the user is a presenter or a if the user is an attendee
	if (activeRooms.roomIndexByID(req.params.roomID) > -1 && req.params.userType === "p") {
		// A presenter has logged in
		res.sendFile(__dirname + clientDir + "/presenterroom.html");
	}
	else if (activeRooms.roomIndexByID(req.params.roomID) > -1 && req.params.userType === "a") {
		// An attendee has logged in
		res.sendFile(__dirname + clientDir + "/attendeeroom.html");
	}
	else {
		res.send("<h1>Room Not Found</h1>");
	}
});


io.on("connection", function(socket) {

	function awsFeedback(err, data, socketEvent) {
    	// Emits a socket event and passes the error and data objects that will come from the AWS service call
    	socket.emit(socketEvent, {err: err, data: data});
	}

	// Listen for create-room event, which is called when the user clicks the submit button in the "Create A Room" section on the landing page
	socket.on("create-room", function(data) {
		// IP address of the room
		var host = data.host;
		var roomID = data.host;
		
		// Countdown for number of DynamoDB add item fails
        var dynamoFails = 5;

        // Countdown for number of Queue creation fails.
        var queueFails = 5;
		
		// This function will be provided a boolean of whether or not a unique ID has been generated
		function testIDCallback(result) {
			if (result === false) {
				// The ID is not unique - another room is already on this network
				console.log("Another room already exists here.");
				socket.emit("duplicate", {err: null, data: result});
			}
			else {
				// The ID is unique, create the room and entry in database
				console.log("Creating room with ID " + host);
				// Add the newly created room's ID to the list of active rooms
				var newRoom = new Room(roomID);
				activeRooms.push(newRoom);
				aws.addRoomToDB(host, host, addToDBCallback);
			}
		}
		
		function addToDBCallback(err, data) {
			if (err && dynamoFails > 0) {
				dynamoFails--;
	
                console.log("Retrying " + host);
				// Retry the database add
				aws.addRoomToDB(host, host, addToDBCallback);
			}
			else {
				console.log("DB entry completed!");
				socket.emit("complete-db-add", {err: err, data: data, roomID: host});
			}
		}

		function createQueueCallback(err, data) {
			if (err && queueFails > 0) {
				queueFails--;
	
                console.log("Retrying create a chat queue for " + roomName + " and " + roomID);
				
				// Retry the database add
				aws.createQueueSQS(roomID, createQueueCallback);
			}
			else {
				socket.emit("complete-queue-creation", {err: err, data: data});
			}
		}
		
		// Calls the test and will fire the testIDCallback (along with the rest of the callbacks) when finished, resulting in bucket, DB entry creation, and sending of emails
		aws.testRoomID(host, testIDCallback);
	});
	
	socket.on("redo-room", function(data) {
		console.log("Redoing room creation...");
		
		// IP address of the room
		var host = data.host;
		var roomID = data.host;

        // Countdown for number of DynamoDB add item fails
        var dynamoFails = 5;
        
        function deleteFromDBCallback(err, data) {
			if (err && dynamoFails > 0) {
				dynamoFails--;
	
                console.log("Retrying " + host);
				// Retry the database delete
				aws.deleteRoomFromDB(host, host, deleteFromDBCallback);  
			} else {
				console.log("DB entry deleted!");
				socket.emit("complete-delete-db", {err: err, data: data});
				aws.addRoomToDB(host, host, addToDBCallback);
			}
		}
		
		function addToDBCallback(err, data) {
			if (err && dynamoFails > 0) {
				dynamoFails--;
	
                console.log("Retrying " + host);
				// Retry the database add
				aws.addRoomToDB(host, host, addToDBCallback);
			}
			else {
				console.log("DB entry completed!");
				socket.emit("complete-db-add", {err: err, data: data, roomID: host});
			}
		}
        
        //aws.deleteBucket(roomID, deleteBucketCallback);
        aws.deleteRoomFromDB(host, roomID, deleteFromDBCallback);
	});

	socket.on("resend-email", function(data) {
		aws.sendEmail(data.emails, data.instructorName, data.roomID, awsFeedback, externalIP);
	});


	socket.on("add-to-room", function(data) {
		var user = new User(data.username, data.userIsPresenter, socket.id);
		console.log("A new " + ((user.isPresenter) ? "presenter" : "attendee") + " named " + user.name + " entered the room " + data.roomID);
		socket.join(data.roomID);
		var currentRoom = activeRooms[activeRooms.roomIndexByID(data.roomID)];
		currentRoom.userList.push(user);
		console.log("pushing update event to room " + data.roomID + " and user list " + currentRoom.userList);
		// Emits event to all in the new user's room including the new user
		io.in(data.roomID).emit("update", currentRoom.userList);
		
		var roomID = data.roomID;
		var mainFileURL = null;

		aws.listObjects(roomID, listObjectsCallback);

		// Emit a event to recover all chat history for the user.
		aws.recoverChatHistorySQS(data.roomID, recoverChatHistorySQSCallback);

		function recoverChatHistorySQSCallback(err, data) {
			socket.emit("chat-history", {messages: currentRoom.chatHistory});	
		}
	});
    
    // Listen for delete-room event, which is called when the instructor leaves the room
	socket.on("delete-room", function(data) {
        // IP address of the room
		var host = data.host;
		var roomID = data.host;

        // Countdown for number of DynamoDB add item fails
        var dynamoFails = 5;
        
        function deleteFromDBCallback(err, data) {
			if (err && dynamoFails > 0) {
				dynamoFails--;
	
                console.log("Retrying " + host);
				// Retry the database delete
				aws.deleteRoomFromDB(host, host, deleteFromDBCallback);  
			}
			else {
				socket.emit("delete-db-add", {err: err, data: data});
			}
		}
        
        //aws.deleteBucket(roomID, deleteBucketCallback);
        aws.deleteRoomFromDB(host, roomID, deleteFromDBCallback);
    });
	
	// Listen for a chat message and broadcast for all users in the room.
	socket.on("chat-send-message", function(data) {
		var roomID = data.roomID;
		var username = data.username;
		var userIsPresenter = data.userIsPresenter;

		// adding the user object to the data object that will be send to client.
		console.log('User named ' + username + ' in the room' + roomID + ' sent a message on chat.');

		var sendData = {
			roomID: roomID,
			username: username,
			userIsPresenter: userIsPresenter,
			message: data.message,
			sentTime: (new Date).getTime()
		};

		// broadcasting the message.
		io.in(roomID).emit("chat-receive-message", sendData);

		// send the message to queue to store a chat history.
		aws.logChatHistory(roomID, sendData);

		if (!activeRooms[activeRooms.roomIndexByID(roomID)].chatHistory)
			activeRooms[activeRooms.roomIndexByID(roomID)].chatHistory = new Array();

		activeRooms[activeRooms.roomIndexByID(roomID)].chatHistory.push(sendData);
	});

	socket.on("req-room-info", function(data) {
		var roomData = activeRooms[activeRooms.roomIndexByID(data.roomID)];
		socket.emit("res-room-info", roomData);
	});

	socket.on("toggle-hand", function(data) {
		var roomIndex = activeRooms.toggleHand(data.roomID, socket.id);
		if (typeof(roomIndex) !== "undefined")
			io.in(data.roomID).emit("update", activeRooms[roomIndex].userList);
	});

	socket.on("upload-file", function(data) {
		debugger;
		function uploadFileS3BucketCallback(err, data) {
			debugger;
			if (!err) {				
				socket.emit("complete-file-upload", {err: err, data: data});
				aws.listObjects(data.roomID, listObjectsCallback);
			}		 
		}
		
		// Upload the file in the bucket.
		aws.uploadFileToS3Bucket(data.roomID, data.file, false, uploadFileS3BucketCallback);
	});

	socket.on('disconnect', function () {
		// Gets the ID of the room that the user has been deleted from, if a user has been deleted
		var discRoomID = activeRooms.deleteUserBySocketID(socket.id);

		// If the discRoomID is not undefined, a user has been removed from a room
		if (typeof(discRoomID) !== "undefined") {
			console.log("user has disconnected from room " + discRoomID);
			// Update all sockets in the room with the new user list
			var currentRoom = activeRooms[activeRooms.roomIndexByID(discRoomID)];
			io.in(discRoomID).emit("update", currentRoom.userList);
		}
	});

	function headObjectCallback(err, data, roomID) {
		debugger;
		if (err) {
			console.log("Error retrieving files.");
		} else {
			if (data['ismain'] == 'True') {
				var mainFileURL = "http://s3.amazonaws.com/tcnj-csc470-nodejs-" + roomID + "/" + data['name'];
				io.in(roomID).emit("update-main-file", {err: err, data: mainFileURL});
			}
		}	
	}
		
	function listObjectsCallback(err, data, roomID) {
		debugger;
		if (err) {
			console.log("Error retrieving files.");
		} else {
			if (data.length > 1 || data[0] != null) {
				var files = new Array();
				console.log("Updating file list for room " + roomID);
				for (var file in data) {
					var name = data[file]["Key"];
					var link = "http://s3.amazonaws.com/tcnj-csc470-nodejs-" + roomID + "/" + name;
					if (name != null) {
						files.push([name,link]);
						aws.headObject(roomID, name, headObjectCallback);
					}
				}
				// Post the data to the GUI
				io.in(roomID).emit("update-file-list", {err: err, data: files});
			} else {
				console.log("No files found for room " + roomID);
				io.in(roomID).emit("update-file-list", "No files to view");
			}
		}
	}
});

function Room(id, name, instructorName) {
	this.id = id;
	this.name = name;
	this.userList = [];
	this.instructorName = instructorName;
}

function User(name, isPresenter, socketID) {
	this.name = name;
	this.isPresenter = isPresenter;
	this.socketID = socketID;
	this.handRaised = false;
}