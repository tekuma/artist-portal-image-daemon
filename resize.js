const firebase = require('firebase');
const jimp     = require('jimp');
const gcloud   = require('gcloud');
const Clarifai = require('clarifai');

// ==== Global Variables ========
const tagCutoff = .85;
const small     = 128;
const large     = 512;
const quality   = 85;

// =========== Methods ================


initializeFirebase = () => {
  firebase.initializeApp({
    databaseURL   : "https://artist-tekuma-4a697.firebaseio.com",
    serviceAccount: "auth/googleServiceKey.json"
  });
}

listenForData = () => {
  let path = 'jobs';
  console.log(">>> Firebase Conneced. Listening for jobs...");
  firebase.database().ref(path).on('child_added', handleData);
}

handleData = (snapshot) => {
  let data = snapshot.val();
  console.log("Child was detected!!! ->", data);
  if (!data.complete) {
      console.log(">>> Job Added!");
      autoTag(data);
        // TODO resize
  } else {
      console.log("<completed>");
  }

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
    return new Promise( function(resolve,reject){
        let gcs = gcloud.storage({
            keyFilename: './auth/googleServiceKey.json',
            projectId  : 'artist-tekuma-4a697'
        });
        console.log(">storage connected");
        resolve([gcs,data]);
    });
}

retrieveImageFile = (input) => {
    let gcs  = input[0];
    let data = input[1];
	return new Promise(function(resolve,reject){
		console.log(">>> Retrieveing image");
	    let lifespan = 90000; // timespan of image URL to be not password protected. 90 seconds.
	    let expires  = new Date().getTime() + lifespan;
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

callClarifai = (input) => {
    let url  = input[0];
    let data = input[1];
	console.log(">calling clarifai");
	return new Promise(function (resolve, reject){
		    //NOTE url is an auth'd url for {lifespan} ms
		    let clientID    = "M6m0sUVsWLHROSW0IjlrG2cojnJE8AaHJ1uBaJjZ";
		    let clientScrt  = "DPPraf1aGGWgp08VbDskYi-ezk1lWTet78_zBER1"; //WARN: SENSITIVE
		    Clarifai.initialize({
		      'clientId'    : clientID,
		      'clientSecret': clientScrt
		    });
		    console.log(">Clarifai Connected Successfully", url);
            let timer = 3000; //3000ms
            setTimeout(()=>{
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
		    },(err)=>{console.log(err);});},
            timer);
		});
}

recordInDatabase = (results) => {
		let tagResult   = results[0];
		let colorResult = results[1];
		let docid       = results[2];
        let data        = results[3];
		console.log(">>Connecting to firebase");

		let dataPath = `/public/onboarders/${data.uid}/artworks/${data.name}`;

		console.log('=============================');
		console.log(">>User:", data.uid, "Artwork:", data.name, "Path:",dataPath );
		console.log(">>Retrieved all info from Clarifai. Tags:", tagResult, "Color:", colorResult);

		let dbRef;
		try {
		    dbRef = firebase.database().ref(dataPath); //root refrence
		} catch (e) {
		    firebase.initializeApp({
		      databaseURL   : "https://artist-tekuma-4a697.firebaseio.com",
		      serviceAccount: "./auth/googleServiceKey.json"
		    });
		    dbRef = firebase.database().ref(dataPath)
		}
        let tagList = [];
        // create a tag object consistent with UX library
        for (let i = 0; i < tagResult.probs.length; i++) {
            // setting arbitrary cut-offs
            if ((tagResult.probs[i] >= tagCutoff && i < 16) || i < 4) {
                let tagObj = {
                    id   : i+1,
                    text : tagResult.classes[i]
                };
                tagList.push(tagObj);
            }
        }
        let updates = {
            colors :colorResult,
            tags   : tagList,
            doc_id : docid
        }
        console.log("> About to update Firebase");
        firebase.database().ref(dataPath).update(updates,(err)=>{
            console.log(">>Firebase Database set ; err:", err);
            markJobComplete(data.job_id);
        });
}

markJobComplete = (jobID) => {
    let jobPath =  `jobs/${jobID}`;
    firebase.database().ref(jobPath).update(null);
    console.log("!>>Job:",jobID,"is complete");
}


// ======= Resize Code ===============


resizeAndUploadThumbnail = (image, width, quality) => {
    console.log(">processing image:", width);
    image.resize(width,jimp.AUTO).quality(quality).getBuffer(jimp.MIME_PNG, (err, tbuffer)=>{
        if(err){console.log(err);}
        let dest    = name.replace('uploads','thumb512');
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
                console.log(">>Thumbnail 512xAUTO success");
            } else {
                console.log(err);
            }
        });
    });
}

getFileThenResize = (small, large, quality) => {
    const name      = data.name;
    let path        = name.split('/');
    let fromPortal  = path.indexOf('portal')  > -1; //file from artist portal UX
    let fromUploads = path.indexOf('uploads') > -1; //art upload, not avatar or something else
    let isUpload    = data.resourceState === 'exists'; //as opposed to a deletion trigger
    if (fromPortal && fromUploads && isUpload) {
        let thisUID  = path[1];
        let artUID   = path[3];

        let gcs = gcloud.storage({
            keyFilename: './googleServiceKey.json',
            projectId  : 'artist-tekuma-4a697'
        });
        let bucket  = gcs.bucket(data.bucket);
        let master  = bucket.file(name);
        master.download((err,buffer)=>{
            console.log(">Download Success");
            jimp.read(buffer).then((image)=>{
                console.log(">processing image");

                resizeAndUploadThumbnail(image.clone(), small, quality);
                resizeAndUploadThumbnail(image, large, quality);

            }).catch((err)=>{
                console.log(err);
            });
        });
    }
}




getFileThenResize(small, large, quality);
// ========== Overall Logic ======================

initializeFirebase();
listenForData();
