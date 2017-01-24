
# Artist-tekuma Server
##### Back-end code for [artist.tekuma.io](https://artist.tekuma.io/)
##### Handles image resizing, jobs, etc

NOTE: Use Node.js LTS version v(6.9.1)
NOTE: NPM v3.8.10

## Using Server
- Log in via SSH to `server1` (10.142.0.2) from [Google Cloud Console](https://console.cloud.google.com/compute/instances?project=artist-tekuma-4a697)

- IF returning: `tmux a -t server` to go to active process.
- IF restarted: go to `/tekuma/artist-server`
 - `tmux new -s server`

- Run `sudo node image_daemon.js` to start the server code

## image_daemon.js
The image daemon handles all back-end processes. Rather than using an HTTP interface with node (like express and AJAX), the artist portal creates "jobs" in the artist-tekuma database, at:
`https://console.firebase.google.com/project/artist-tekuma-4a697/database/data/jobs`

The image_daemon listens for any changes to this branch of the DB, and pops jobs off as they arrive. The script loads in all jobs, then executes them in a stack (only 2 concurrently).

Image resizing daemon uses the Jimp library for image operations. Jimp was originally chosen due to its ability to run in any NodeJS container/engine/cloud function, and for having zero dependencies.

Jobs on the server will be received as JSONs from the firebase DB. They should have the form:
```
-KYAOSwR5VFOM1d7oj-2: {
    bucket   : "art-uploads",             // the GC bucket fullsize image is in
    complete : true,                      // if the job has been Successfully completed.
    completed: "2016-12-04T19:53:20.947Z" // When job was marked complete.
    file_path: "portal/vqy3UGVZQzN7GjHQeeFBKhe7wY72/uploads/-KYAOSm2qS6-EuwXOgME",
                          // the path to the image, inside of the bucket.
    job_id   : "-KYAOSwR5VFOM1d7oj-2",     // UID for this job
    name     : "-KYAOSm2qS6-EuwXOgME" ,    // the Artwork UID of the image
    submitted: "2016-12-04T19:53:20.947Z", // time job was created
    task     : "resize",  // what the job is (resize || tag || submit)
    uid      : "vqy3UGVZQzN7GjHQeeFBKhe7wY72"  //the user's UID
}
```

## Keys
The image-daemon has global read and write access to the curator-tekuma and artist-tekuma-4a697 Google Cloud/Firebase projects. This is via the service keys in the `/auth` directory. NOTE: Sensitive!!!

These keys enable use of the `firebase-admin` npm library, instead of `firebase`.
These have administrative privileged over all data.

## Security
The server, a Google Compute Engine instance called `server1`, should:

- Only be accessible from SSH, not HTTP

## Notes about tmux
### [CheatSheet](https://gist.github.com/MohamedAlaa/2961058)

- Kill all sessions:
 - `tmux ls | grep : | cut -d. -f1 | awk '{print substr($1, 0, length($1)-1)}' | xargs kill`

- Kill session:
 - `tmux kill-session -t myname`

- Begin session:
 - `tmux new -s myname`

- Attach to session:
 - `tmux a -t myname`

- List all sessions:
 - `tmux ls`

## Dependencies
- [tmp](https://github.com/raszi/node-tmp)
- [GCloud](http://googlecloudplatform.github.io/google-cloud-node/#/docs/google-cloud/0.37.0/storage/file)
- [imagemagick](https://www.npmjs.com/package/imagemagick)
 - NOTE this is just the node client. The imagemagick suite must also be installed. On ubuntu, it can be install via `sudo apt-get install imagemagick`
