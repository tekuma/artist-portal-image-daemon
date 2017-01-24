// JS ES6+
// Copyright 2016 Tekuma Inc.
// All rights reserved.
// created by Stephen L. White
//
//  See README.md for more.

// We use 'jobs' to list tasks to be handled server-side.
// Below is an example _Job_ object.
/*
-KYAOSwR5VFOM1d7oj-2: {
    bucket   : "art-uploads", // the GC bucket fullsize image is in
    complete : true, // if the job has been Successfully completed.
    completed: "2016-12-04T19:53:20.947Z" // When job was marked complete.
    file_path: "portal/vqy3UGVZQzN7GjHQeeFBKhe7wY72/uploads/-KYAOSm2qS6-EuwXOgME",
                // the path to the image, inside of the bucket.
    job_id   : "-KYAOSwR5VFOM1d7oj-2",  // UID for this job
    name     : "-KYAOSm2qS6-EuwXOgME" ,  // the Artwork UID of the image
    submitted: "2016-12-04T19:53:20.947Z", // time job was created
    task     : "resize",  // what the job is (resize || tag)
    uid      : "vqy3UGVZQzN7GjHQeeFBKhe7wY72" //the user's UID
}
 */

//Libs
const firebase = require('firebase-admin');
const gcloud   = require('google-cloud');
const Clarifai = require('clarifai');
const tmp        = require('tmp');
const im         = require('imagemagick');

//Keys
const serviceKey = require('./auth/artistKey.json');
const curatorKey = require('./auth/curatorKey.json');


// ==== Global Variables ========
const tagCutoff  = .85; // (0-1) Cutoff for the 'certainty' of tags returned


// DEFAULT App : artist-tekuma-4a697 connection
firebase.initializeApp({
    databaseURL : "https://artist-tekuma-4a697.firebaseio.com",
    credential  : firebase.credential.cert(serviceKey)
});
// SECONDARY App : curator-tekuma connection
var curator  = firebase.initializeApp({
    databaseURL : "https://curator-tekuma.firebaseio.com/",
    credential  : firebase.credential.cert(curatorKey)
}, "curator");

var queue = [];
var limit = 2;

/**
 * Establishes a listen on the /jobs branch of the DB. Any children added
 * to the node will trigger the handleData callback.
 */
listenForData = () => {
    let path = 'jobs/';
    console.log(">>> Firebase Conneced. Listening for jobs...");
    firebase.database().ref(path).on('child_added', handleIncomeJobs);
}

/**
 * Main handler. Checks job queue every 5 seconds. Only allows
 * 2 jobs to run concurrently. This is an implementation of a
 * "leaky bucket" approach to prevent overloading the script.
 */
handleActiveJobs = () =>{
    // console.log("1-1-1-1-1-1-1-1");
    // console.log(queue.length);
    // console.log("Limit",limit);
    while (limit > 0 && queue.length > 0) {
        limit--;
        let job = queue.pop();
        handlePop(job);
    }
    setTimeout( ()=>{
        handleActiveJobs();
    }, 5000);
}

/**
 * [handlePop description]
 * @param  {Object} data [The job json from firebase]
 */
handlePop = (data) => {
    //FIXME handle with switch statement
    console.log("Job:", data.job_id, "initiated");
    if (!data.complete) {
        if (data.task === "autotag") {
            console.log(data.name," >>> Job Initiated in autotag!");
            autoTag(data);
        } else if (data.task === "resize"){
            console.log(data.name," >>> Job Initiated in resize!");
            resize(data);
      } else if (data.task === "submit") {
            console.log(data.name, ">> Job initiated in submit");
            submit(data);
      } else {
            console.log(" :( unrecognized task ",data.task);
      }
  } else {
      console.log(data.job_id, "<complete>");
      removeJob(data.job_id);
  }
}

/**
 * Extracts the job it as passed, checks if it is already complete
 * (if it is, remove the job from the stack) and initiates the task of the job
 * @param  {Snapshot} snapshot Firebase Snapshot object
 */
handleIncomeJobs = (snapshot) => {
    let data = snapshot.val();
    console.log("Job:", data.job_id, "deteched by artist:", data.uid);
    if (data.uid === 1) {
        console.log("placeholder");
    } else if (!data.complete) {
        console.log(data.name," >>> Added to queue");
        queue.push(data);

    } else {
      console.log(data.job_id, "<complete>");
      removeJob(data.job_id);
  }
}

submit = (data) => {
    curator.database().ref(`submissions/${data.artwork_uid}`).set(data.submission).then(()=>{
        console.log(">> Submission added to list.");
        limit++; // End point of submit job
        markJobComplete(data.job_id,true);
    });

}

/**
 * Mutates the job.complete field to true in the FB database
 * @param  {String}   jobID    [UID of job]
 * @param  {bool} remove  [if true, delete the job]
 */
markJobComplete = (jobID,remove) => {
    let jobPath = `jobs/${jobID}`;
    let jobRef  = firebase.database().ref(jobPath);
    jobRef.update({complete:true}).then( ()=>{
        console.log("!>>Job:",jobID,"is marked complete");
        if (remove) {
            removeJob(jobID);
        }
    });
}

/**
 * Deletes jobID from Firebase DB
 */
removeJob = (jobID) => {
    let jobPath = `jobs/${jobID}`;
    firebase.database().ref(jobPath).remove().then(()=>{
        console.log("|>> Job:",jobID, "<Deleted>");
    });
}

/**
 * Creates a new Job in the DB
 */
submitJob = (path, uid, artworkUID, task) => {
    let url      = firebase.database().ref('jobs').push();
    let jobID    = url.path.o[1];
    let job = {
        task     : task,  //
        uid      : uid,   //
        file_path: path,  //
        job_id   : jobID,
        complete : false,
        bucket   : "art-uploads",
        name     : artworkUID, //
        submitted: new Date().toISOString(),
    }
    let jobPath = `jobs/${jobID}`;
    let jobRef  = firebase.database().ref(jobPath);
    console.log(jobRef.toString());
    jobRef.set(job, ()=>{
        console.log(">>Job",jobID,"<submitted>");
    });
}

// ======= autoTag code ========

autoTag = (data) => {
    console.log(">Autotag");
    logInToStorage(data)
        .then(callClarifai)
        .then(recordInDatabase);
}

logInToStorage = (data) => {
    return new Promise( (resolve,reject)=>{
        let projId = 'artist-tekuma-4a697';
        let gcs = gcloud.storage({
            credentials: serviceKey,
            projectId  : projId
        });
        console.log(">storage connected");
        resolve([gcs,data]);
    });
}


/**
 * [callClarifai description]
 * @param  {Array} input return from retrieveImageFile
 */
callClarifai = (input) => {
    let gcs  = input[0];
    let data = input[1];
    // public read link to 512px image
    let url  = `https://storage.googleapis.com/art-uploads/portal/${data.uid}/thumb512/${data.name}`;

	return new Promise( (resolve, reject)=>{
	    //NOTE url is an auth'd url for {lifespan} ms
	    let clientID    = "M6m0sUVsWLHROSW0IjlrG2cojnJE8AaHJ1uBaJjZ";
	    let clientScrt  = "DPPraf1aGGWgp08VbDskYi-ezk1lWTet78_zBER1"; //WARN: SENSITIVE
	    Clarifai.initialize({
	      'clientId'    : clientID,
	      'clientSecret': clientScrt
	    });
	    console.log(">Clarifai Connected Successfully");

        Clarifai.getTagsByUrl(url).then( (tagResponse)=>{
            console.log(">Recieved Tags");
	        let tagResult = tagResponse.results[0].result.tag;
	        let docid     = tagResponse.results[0].docid;
	        Clarifai.getColorsByUrl(url).then( (colorResponse)=>{
                console.log(">Recieved Colors");
	            let colorResult = colorResponse.results[0].colors;
	            resolve([tagResult, colorResult, docid, data]);
	        }, (err)=>{console.log(err);});
	    },(err)=>{
            console.log(err);
            console.log(err.results[0].result);
            console.log("Clarifai Error with::=>", data.job_id);
        });
	});
}

/**
 * Records outputs from Clarifai to DB.
 */
recordInDatabase = (results) => {
	let tagResult   = results[0];
	let colorResult = results[1];
	let docid       = results[2];
    let data        = results[3];
	console.log(">> Connecting to firebase DB ");
    dataPath = `public/onboarders/${data.uid}/artworks/${data.name}`;
	console.log('=============================');
	console.log(">>User:", data.uid, "Artwork:", data.name, "Path:",dataPath );
	let dbRef;
	try { // may or maynot need to re-initialize connection to FB
	    dbRef = firebase.database().ref(dataPath); //root refrence
	} catch (e) {
	    initializeFirebase();
	    dbRef = firebase.database().ref(dataPath);
	}
    let tagList = [];
    // create a tag object consistent with frontend library
    for (let i = 0; i < tagResult.probs.length; i++) {
        //NOTE: setting arbitrary cut-offs for amount/certainty of tags.
        // If certainty >= cutoff, take 16 tags, else only 4.
        if ((tagResult.probs[i] >= tagCutoff && i < 16) || i < 4) {
            let tagObj = {
                id   : i+1,
                text : tagResult.classes[i]
            };
            tagList.push(tagObj);
        }
    }
    let updates = {
        colors : colorResult,
        tags   : tagList,
        doc_id : docid
    }
    console.log("> About to update Firebase");

    //TODO: consider using .transaction instead of .update
    firebase.database().ref(dataPath).update(updates,(err)=>{
        console.log(">>Firebase Database set ; err:", err);
        limit++; // ENDPOINT of autotag job
        markJobComplete(data.job_id, true);
    });
}



// ======= Resize Code ===============

/**
 * Initializes the resize process. As the file was just uploaded,
 * use a timeout to allow the upload to propagate through GCloud
 * @param  {snapshot} data object passed from listener
 */
resize = (data) => {
    let timespan = 1000;
    setTimeout(()=>{
        getFileThenResize(data);
    }, timespan);
}


getFileThenResize = (data) => {
    logInToStorage(data).then((args)=>{
        let gcs = args[0];
        let bucket  = gcs.bucket(data.bucket);
        console.log(data.file_path);
        let fullsize_image  = bucket.file(data.file_path);

        let tmp_settings  = {
            keep   : false,
            prefix : "tekuma-",
            postfix: ".png",
            dir    :"./downloads"
        };
        let tmp_settings2 = {
            keep   : false,
            prefix : "tekuma2-",
            postfix: ".png",
            dir    :"./downloads"
        };
        let tmp_settings3 = {
            keep   : false,
            prefix : "tekuma3-",
            postfix: ".png",
            dir    :"./downloads"
        }

        tmp.file(tmp_settings, function _tempFileCreated(err, path_full, fd, cleanupCallback) {
            console.log("== temp1 made");
            fullsize_image.download({destination:path_full}, (err)=>{
                console.log("== fullize download complete");
                tmp.file(tmp_settings2, function _tempFileCreated(err2, path128, fd2, cleanupCallback2) {
                    console.log("== temp2 made");
                    tmp.file(tmp_settings3, function _tempFileCreated(err3, path512, fd3, cleanupCallback3) {
                        console.log("== temp3 made");
                        let resize128options = {
                            srcPath: path_full,
                            dstPath: path128,
                            width  : 128,
                            format : 'png'
                        };

                        im.resize(resize128options, (err, stdout, stderr)=>{
                            if (err) throw err;
                            console.log("->Resize 128 completed.", data.job_id);
                            let resize512options = {
                                srcPath: path_full,
                                dstPath: path512,
                                width  : 512,
                                format : 'png'
                            };

                            im.resize(resize512options, (err, stdout2, stderr2)=>{
                                if (err) throw err;
                                console.log("->Resize 512 completed.", data.job_id);
                                let upload_options128 = {
                                    destination:`portal/${data.uid}/thumb128/${data.name}`,
                                    metadata:{
                                        contentType: 'image/png'
                                    },
                                    // make the thumbnail publicly readable
                                    predefinedAcl:"publicRead"
                                }
                                bucket.upload(path128,upload_options128, (err,file,res)=>{
                                    console.log("->thumb128 upload complete:",data.job_id);
                                    let upload_options512 = {
                                        destination:`portal/${data.uid}/thumb512/${data.name}`,
                                        metadata:{
                                            contentType: 'image/png'
                                        },
                                        // make the thumbnail publicly readable
                                        predefinedAcl:"publicRead"
                                    }
                                    bucket.upload(path512,upload_options512, (err,files,res)=>{
                                        console.log("->Thumbails complete for:",data.job_id);
                                        limit++; //ENDPOINT of resize job
                                        let dest = `portal/${data.uid}/thumb512/${data.name}`;
                                        submitJob(dest, data.uid, data.name, "autotag");
                                        markJobComplete(data.job_id, true);

                                        cleanupCallback();
                                        cleanupCallback2();
                                        cleanupCallback3();
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}


// ========== Overall Logic ======================

handleActiveJobs();
listenForData();
