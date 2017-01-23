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
const jimp     = require('jimp');
const gcloud   = require('google-cloud');
const Clarifai = require('clarifai');
//Keys
const serviceKey = require('./auth/artistKey.json');
const curatorKey = require('./auth/curatorKey.json');


// ==== Global Variables ========
const tagCutoff  = .85; // (0-1) Cutoff for the 'certainty' of tags returned
const small      = 128; // width of 'small' thumbnail generated
const large      = 512; // width of 'large' thumbnail generated
const quality    = 90;  // jpg quality param requested by Jimp

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


handlePop = (data) => {
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
    if (!data.complete) {
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
        let key = "auth/googleServiceKey.json";
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
    let timespan = 2500;//ms
    setTimeout(()=>{
        getFileThenResize(small, large, quality, data);
    }, timespan);
}


getFileThenResize = (small, large, quality, data) => {
    logInToStorage(data).then((args)=>{
        let gcs = args[0];
        let bucket  = gcs.bucket(data.bucket);
        console.log(data.file_path);
        let originalUpload  = bucket.file(data.file_path);
        originalUpload.download((err,buffer)=>{
	    if (buffer) {
            if (buffer.length < 21000000) { // < 21 Mb
                console.log(">Download Success |", buffer.length, "bytes |",buffer);
                jimp.read(buffer).then((image)=>{
                    console.log(">Begining to generate thumbnails...");
                    let clone = image.clone();

                    resizeAndUploadThumbnail(clone, small, quality, data, bucket)
                    .then((success1)=>{
                        if (success1) {
                            resizeAndUploadThumbnail(image, large, quality, data, bucket)
                            .then((success2)=>{
                                if (success2) {
                                    console.log(">>> Resizing finished successfully");
                                    let dest    = `portal/${data.uid}/thumb512/${data.name}`;
                                    limit++; //ENDPOINT of resize job
                                    markJobComplete(data.job_id, true);
                                    submitJob(dest, data.uid, data.name, "autotag");
                                }
                            });
                        }
                    });

                }).catch((err)=>{
                    console.log(err);
                });

	    } else {
                console.log("Buffer Download Error=>",buffer.length, "|", err);
            }
	    }
        });
    });
}

/**
 * Where resizing occurs.
 * NOTE: Thumbnails are generated as PNG
 * NOTE: Thumbnails are saved as publicly accessible
 *
 */
resizeAndUploadThumbnail = (image, width, quality, data, bucket) => {
    return new Promise((resolve, reject)=>{
        console.log(">processing image:", width);
        //NOTE: jimp.AUTO will dynamically retain the origin aspect ratio
        image.resize(width,jimp.AUTO).quality(quality).getBuffer(jimp.MIME_PNG, (err, tbuffer)=>{
            if(err){console.log("resize error:",err);}
            let dest    = `portal/${data.uid}/thumb${width}/${data.name}`;
            let thumb   = bucket.file(dest);
            let options = {
                metadata:{
                    contentType: 'image/png'
                },
                // make the thumbnail publicly readable
                predefinedAcl:"publicRead"
            };

            thumb.save(tbuffer, options, (err)=>{
                if (!err) {
                    console.log(`>>Thumbnail ${width}xAUTO success`);
                    resolve(true);
                } else {
                    console.log("Error saving thumbnail",err);
                    resolve(false);
                }
            });
        });
    });

}



// ========== Overall Logic ======================

handleActiveJobs();
listenForData();
