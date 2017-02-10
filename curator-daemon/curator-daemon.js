// JS ES6+
// Copyright 2017 Tekuma Inc.
// All rights reserved.
// created by Stephen L. White
//
//  See README.md for more.

//Libs
const firebase = require('firebase-admin');
const gcloud   = require('google-cloud');

//Keys
const serviceKey = require('../auth/artistKey.json');
const curatorKey = require('../auth/curatorKey.json');


// DEFAULT App : artist-tekuma-4a697 connection
firebase.initializeApp({
    databaseURL : "https://artist-tekuma-4a697.firebaseio.com",
    credential  : firebase.credential.cert(serviceKey)
});
// SECONDARY App : curator-tekuma connection
const curator  = firebase.initializeApp({
    databaseURL : "https://curator-tekuma.firebaseio.com/",
    credential  : firebase.credential.cert(curatorKey)
}, "curator");


/**
 * Establishes a listen on the /jobs branch of the DB. Any children added
 * to the node will trigger the handleData callback.
 */
listenForApprovals = () => {
    let path = 'approved/';
    console.log(">>> Firebase Conneced. Listening for approved...");
    curator.database().ref(path).on('child_added', handleSqlInsert);
}

handleSqlInsert = (snapshot) => {
    //TODO insert into cloudsql via gcloud
}
