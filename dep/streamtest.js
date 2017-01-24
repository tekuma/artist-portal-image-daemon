const gcloud     = require('google-cloud');
const serviceKey = require('./auth/artistKey.json');
const tmp        = require('tmp');
const im         = require('imagemagick');



let gcs = gcloud.storage({
    credentials: serviceKey,
    projectId  : 'artist-tekuma-4a697'
});
console.log(">storage connected");

let bucket  = gcs.bucket("art-uploads");
// just a random image path
let path = 'portal/3FioyTv4vSNlHYsgmJUiZ7VnId83/uploads/-KQhFe675vQyuLsleNcu';
let imageFile = bucket.file(path);

console.log("----");
let tmp_settings = {
    keep   : true,
    prefix : "tekuma-",
    postfix: ".png",
    dir    :"./downloads"
};

let tmp_settings2 = {
    keep   : true,
    prefix : "tekuma2-",
    postfix: ".png",
    dir    :"./downloads"
};

let tmp_settings3 = {
    keep   : true,
    prefix : "tekuma3-",
    postfix: ".png",
    dir    :"./downloads"
}




tmp.file(tmp_settings, function _tempFileCreated(err, path_full, fd, cleanupCallback) {
    imageFile.download({destination:path_full}, (err)=>{
        tmp.file(tmp_settings2, function _tempFileCreated(err2, path128, fd2, cleanupCallback2) {
            tmp.file(tmp_settings3, function _tempFileCreated(err3, path512, fd3, cleanupCallback3) {
                let resize128options = {
                    srcPath: path_full,
                    dstPath: path128,
                    width  : 128,
                    format : 'png'
                };

                im.resize(resize128options, (err, stdout, stderr)=>{
                    if (err) throw err;
                    console.log("Resize 128 completed. ");
                    let resize512options = {
                        srcPath: path_full,
                        dstPath: path512,
                        width  : 512,
                        format : 'png'
                    };

                    im.resize(resize512options, (err, stdout2, stderr2)=>{
                        if (err) throw err;
                        console.log("Resize 512 completed. ");
                        let upload_options = {
                            destination:"test.png",
                            metadata:{
                                contentType: 'image/png'
                            },
                            // make the thumbnail publicly readable
                            predefinedAcl:"publicRead"
                        }
                        bucket.upload(path128,upload_options, (err,file,res)=>{
                            console.log("DONE");
                            // cleanupCallback();
                            // cleanupCallback2();
                            // cleanupCallback3();
                        });
                    });
                });
            });
        });
    });
});
