const events = require('events');

const eventEmitter = new events.EventEmitter();

let ring = function ringBell() {
    console.log("RINGG");
}

eventEmitter.on('door', ring);

setTimeout(function () {
    eventEmitter.emit('door');
}, 2000);
