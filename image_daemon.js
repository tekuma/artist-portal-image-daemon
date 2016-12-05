// JS ES6+
// Copyright 2016 Tekuma Inc.
// All rights reserved.
// created by Stephen L. White
//
//  Image resizing daemon depending on the Jimp library.
//  Jimp was originally chosen due to its ability to run in any
//  NodeJS container/engine, and for having zero dependencies.

// We use 'jobs' to list tasks to be handled server-side.
// Below is an example _Job_ object.
/*
-KYAOSwR5VFOM1d7oj-2: {
    bucket   : "art-uploads", // the GC bucket fullsize image is in
    complete : true, // if the job has been Successfully completed.
    file_path: "portal/vqy3UGVZQzN7GjHQeeFBKhe7wY72/uploads/-KYAOSm2qS6-EuwXOgME",
                // the path to the image, inside of the bucket.
    job_id   : "-KYAOSwR5VFOM1d7oj-2",  // UID for this job
    name     : "-KYAOSm2qS6-EuwXOgME" ,  // the Artwork UID of the image
    submitted: "2016-12-04T19:53:20.947Z", // time job was created
    task     : "resize",  // what the job is (resize || tag)
    uid      : "vqy3UGVZQzN7GjHQeeFBKhe7wY72" //the user's UID
}
 */

// ==== Order of Events ======
// - at arist.tekuma.io a file is uploaded into art bucket
// - on complete, a job is created, with *task: resize*
// - Job read by daemon, resizing occurs
// - 2 thumbnails saved to gcloud
//


const firebase = require('firebase');
const jimp     = require('jimp');
const gcloud   = require('gcloud');
const Clarifai = require('clarifai');


// ==== Global Variables ========
const production = true; // whether to watch artist-tekuma or dev-artist-tekuma
const tagCutoff  = .85; // (0-1) Cutoff for the 'certainty' of tags returned
const small      = 128; // width of 'small' thumbnail generated
const large      = 512; // width of 'large' thumbnail generated
const quality    = 90;  // jpg quality param requested by Jimp
const lifespan   = 60000; // timespan of image URL, from retrieveImageFile,
                          // to be not password protected. 60 seconds.



// =========== Methods ================

/**
 * Initializes connection to the Firebase DB, a
 * hierarchical DB, rooted at the databaseURL. Connected to the
 * production or dev DB depending on the 'production' global var
 */
initializeFirebase = () => {
    let databaseURL;
    let key;
    if (production) {
        databaseURL = "https://artist-tekuma-4a697.firebaseio.com";
        key = "auth/googleServiceKey.json";
    } else {
        databaseURL = "https://project-7614141605200030275.firebaseio.com";
        key = "auth/devKey.json";
    }
    console.log(databaseURL);
  firebase.initializeApp({
    databaseURL   : databaseURL,
    serviceAccount: key
  });
}

/**
 * Establishes a listen on the /jobs branch of the DB. Any children added
 * to the node will trigger the handleData callback.
 */
listenForData = () => {
  let path = 'jobs';
  console.log(">>> Firebase Conneced. Listening for jobs...");
  firebase.database().ref(path).on('child_added', handleData);
}

/**
 * Extracts the job it as passed, checks if it is already complete
 * (if it is, remove the job from the stack) and initiates the task of the job
 * @param  {Snapshot} snapshot Firebase Snapshot object
 */
handleData = (snapshot) => {
  let data = snapshot.val();
  console.log("Job was detected!!! ->", data.job_id);
  if (!data.complete) {
      if (data.task === "autotag") {
          console.log(data.name," >>> Job Initiated in autotag!");
          autoTag(data);
      } else if (data.task === "resize"){
          console.log(data.name," >>> Job Initiated in resize!");
          resize(data);
      } else {
          console.log(" :( unrecognized task ");
      }
  } else {
      console.log(data.job_id, "<completed>");
      removeJob(data.job_id); //FIXME remove completed jobs.
  }
}

/**
 * Mutates the job.complete field to true in the FB database
 * @param  {String}   jobID    [description]
 * @param  {Function} callback
 */
markJobComplete = (jobID, callback) => {
    let jobPath =  `jobs/${jobID}`;
    let jobRef  = firebase.database().ref(jobPath);
    let updates = {
        complete : true,
        completed:
    }
    jobRef.transaction((data)=>{
        data.completed    = true;
        data["completed"] =  new Date().toISOString();
        return data;
    },(err,wasSuccessful,snapshot)=>{ // after-call
        if (callback !== null) {
            callback(jobID);
        }
    });

    console.log("!>>Job:",jobID,"is marked complete");
}

/**
 * Deletes jobID from Firebase DB
 */
removeJob = (jobID) => {
    let jobPath   =  `jobs/${jobID}`;
    firebase.database().ref(jobPath).set(null, ()=>{
        console.log("#>>Job:",jobID,"<Deleted>");
    });

}

/**
 * Creates a new Job in the DB
 */
submitJob = (path, uid, artworkUID, task) => {
    let url      = firebase.database().ref('jobs').push();
    let jobID    = url.path.o[1];
    let job = {
        task     : task, //
        uid      : uid, //
        file_path: path, //
        job_id   : jobID,
        complete : false,
        bucket   : "art-uploads",
        name     : artworkUID, //
        submitted: new Date().toISOString()
    }
    let jobPath = `jobs/${jobID}`;
    firebase.database().ref(jobPath).set(job, ()=>{
        console.log(">>Job",jobID,"<submitted>");
    });
}

// ======= autoTag code ========

autoTag = (data) => {
    console.log(">Autotag");
    logInToStorage(data)
      .then(retrieveImageFile)
      .then(callClarifai)
      .then(recordInDatabase);
}

logInToStorage = (data) => {
    return new Promise( (resolve,reject)=>{
        let projId;
        let key;
        if (production) {
            projId = 'artist-tekuma-4a697';
            key = "auth/googleServiceKey.json";
        } else {
            projId = 'project-7614141605200030275';
            key = "auth/devKey.json";
        }
        let gcs = gcloud.storage({
            keyFilename: key,
            projectId  : projId
        });
        console.log(">storage connected");
        resolve([gcs,data]);
    });
}

/**
 * Retrieves the URL of the requested image. If the fullsize image is requested,
 * not the thumbnail, the URL must be signed to be accessible as fullsize art
 * is private.
 * @param  {Return} input the return from logInToStorage
 */
retrieveImageFile = (input) => {
    let gcs  = input[0];
    let data = input[1];
	return new Promise( (resolve,reject)=>{
		console.log(">>> Retrieveing image");
	    let expires  = new Date().getTime() + lifespan; // global var
        let thisFile = gcs.bucket(data.bucket).file(data.file_path);

	    let params   = {
	        action : "read",
	        expires: expires,
	    };
		thisFile.getSignedUrl(params, (err,url)=>{
            console.log("err", err);
		    resolve([url,data]);
		});
	});
}

/**
 * [callClarifai description]
 * @param  {Array} input return from retrieveImageFile
 */
callClarifai = (input) => {
    let url  = input[0];
    let data = input[1];
	console.log(">calling clarifai");
	return new Promise( (resolve, reject)=>{
	    //NOTE url is an auth'd url for {lifespan} ms
	    let clientID    = "M6m0sUVsWLHROSW0IjlrG2cojnJE8AaHJ1uBaJjZ";
	    let clientScrt  = "DPPraf1aGGWgp08VbDskYi-ezk1lWTet78_zBER1"; //WARN: SENSITIVE
	    Clarifai.initialize({
	      'clientId'    : clientID,
	      'clientSecret': clientScrt
	    });
	    console.log(">Clarifai Connected Successfully", url);
        let timer = 3000; // 3 sec
        setTimeout(()=>{ // let URL signing propagate
            Clarifai.getTagsByUrl(url).then( (tagResponse)=>{
            console.log(">Recieved Tags");
	        let tagResult = tagResponse.results[0].result.tag;
	        let docid     = tagResponse.results[0].docid;
	        Clarifai.getColorsByUrl(url)
	        .then( (colorResponse)=>{
                console.log(">Recieved Colors");
	            let colorResult = colorResponse.results[0].colors;
	            resolve([tagResult, colorResult, docid, data]);
	        }, (err)=>{console.log(err);});
	    },(err)=>{
            console.log(err);
            console.log("Clarifai Error with::=>", data.job_id);
        })},
        timer);
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
        let dataPath;
        if (production) {
            dataPath = `public/onboarders/${data.uid}/artworks/${data.name}`;
        } else {
            dataPath = `/onboarders/${data.uid}/artworks/${data.name}`;
        }
		console.log('=============================');
		console.log(">>User:", data.uid, "Artwork:", data.name, "Path:",dataPath );
		// console.log(">>Retrieved all info from Clarifai. Tags:", tagResult, "Color:", colorResult);S
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
            markJobComplete(data.job_id, removeJob);
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
                console.log(">Download Success", buffer);
                jimp.read(buffer).then((image)=>{
                    console.log(">Generating thumbnails...");

                    resizeAndUploadThumbnail(image.clone(), small, quality, data, bucket);
                    resizeAndUploadThumbnail(image, large, quality, data, bucket);

                }).catch((err)=>{
                    console.log(err);
                });
            } else {
                console.log("buffer =>",buffer,err);
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
    console.log(">processing image:", width);
    //NOTE: jimp.AUTO will dynamically retain the origin aspect ratio
    image.resize(width,jimp.AUTO).quality(quality).getBuffer(jimp.MIME_PNG, (err, tbuffer)=>{
        if(err){console.log(err);}
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
                markJobComplete(data.job_id, removeJob);
                submitJob(dest, data.uid, data.name, "autotag");
            } else {
                console.log(err);
            }
        });
    });
}



// ========== Overall Logic ======================

initializeFirebase();
listenForData();