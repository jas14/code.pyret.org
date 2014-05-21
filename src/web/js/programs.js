// assumes gapi bound to Google API

function createProgramCollectionAPI(clientId, apiKey, collectionName, immediate) {

  gapi.client.setApiKey(apiKey);
  var drive;
  var SCOPE = "https://www.googleapis.com/auth/drive.file";
  var FOLDER_MIME = "application/vnd.google-apps.folder";
  var BACKREF_KEY = "originalProgram";
  var PUBLIC_LINK = "pubLink";

  var refresh = function(immediate) {
    return reauth(true);
  };

  function authCheck(f) {
    function isAuthFailure(result) {
      return
        (result.error && result.error.code && result.error.code === 401) ||
        (result.code && result.code === 401);
    }
    var retry = f().then(function(result) {
      if(isAuthFailure(result)) {
        return refresh().then(function(authResult) {
          if(!authResult || authResult.error) {
            return {error: { code: 401, message: "Couldn't re-authorize" }};
          }
          else {
            return f();
          }
        });
      } else {
        return result;
      }
    });
    return retry.then(function(result) {
      if(isAuthFailure(result)) {
        throw new Error("Authentication failure");
      }
      return result;
    });
  }

  function gQ(request) {
    console.log("Trying: ", request);
    return failCheck(authCheck(function() {
      var d = Q.defer();
      request.execute(function(result) {
        d.resolve(result);
      });
      return d.promise;
    }));
  }

  function failCheck(p) {
    return p.then(function(result) {
      if(result && (typeof result.code === "number") && (result.code >= 400)) {
        console.log("Error: ", result);
        throw new Error(result);
      }
      return result;
    });
  }

  function createAPI(baseCollection) {
    function makeSharedFile(googFileObject) {
      return {
        shared: true,
        getContents: function() {
          var proxyDownloadLink = "/download?" + encodeURIComponent(googFileObject.webContentLink);
          return Q($.ajax(proxyDownloadLink, {
            method: "get",
            dataType: 'text'
          })).then(function(response) {
            return response;
          });
        },
        getName: function() {
          return googFileObject.title;
        },
        getModifiedTime: function() {
          return googFileObject.modifiedDate;
        },
        getUniqueId: function() {
          return googFileObject.id;
        },
      };

    }
    function makeFile(googFileObject) {
      return {
        shared: false,
        getName: function() {
          return googFileObject.title;
        },
        getModifiedTime: function() {
          return googFileObject.modifiedDate;
        },
        getUniqueId: function() {
          return googFileObject.id;
        },
        getExternalURL: function() {
          return googFileObject.alternateLink;
        },
        getShares: function() {
          return gQ(drive.files.list({
              q: "trashed=false and properties has {key='" + BACKREF_KEY + "' and value='" + googFileObject.id + "' and visibility='PRIVATE'}"
            }))
          .then(function(files) {
            if(!files.items) { return []; }
            else { return files.items.map(makeFile); }
          });;
        },
        getContents: function() {
          return Q($.ajax(googFileObject.downloadUrl, {
            method: "get",
            dataType: 'text',
            headers: {'Authorization': 'Bearer ' + gapi.auth.getToken().access_token },
          })).then(function(response) {
            return response;
          });
        },
        rename: function(newName) {
          return gQ(drive.files.update({
            fileId: googFileObject.id,
            resource: {
              'title': newName
            }
          })).then(makeFile);
        },
        makeShareCopy: function() {
          var shareCollection = findOrCreateShareDirectory();
          var newFile = shareCollection.then(function(c) {
            var sharedTitle = googFileObject.title + "-" + Number(new Date());
            return gQ(drive.files.copy({
              fileId: googFileObject.id,
              resource: {
                "parents": [{id: c.id}],
                "title": sharedTitle,
                "properties": [{
                    "key": BACKREF_KEY,
                    "value": String(googFileObject.id),
                    "visibility": "PUBLIC"
                  }]
              }
            }));
          });
          var updated = newFile.then(function(newFile) {
            return gQ(drive.permissions.insert({
              fileId: newFile.id,
              resource: {
                'role': 'reader',
                'type': 'anyone',
                'id': googFileObject.permissionId
              }
            }));
          });
          return Q.all([newFile, updated]).spread(function(fileObj) {
            return fileObj;
          });
        },
        save: function(contents, newRevision) {
          // NOTE(joe): newRevision: false will cause badRequest errors as of
          // April 30, 2014
          if(newRevision) { 
            var params = { 'newRevision': true };
          }
          else {
            var params = {};
          }
          const boundary = '-------314159265358979323846';
          const delimiter = "\r\n--" + boundary + "\r\n";
          const close_delim = "\r\n--" + boundary + "--";
          var metadata = {
            'mimeType': "text/plain",
            'fileExtension': "arr"
          };
          var multipartRequestBody =
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: text/plain\r\n' +
                '\r\n' +
                contents +
                close_delim;

          var request = gapi.client.request({
              'path': '/upload/drive/v2/files/' + googFileObject.id,
              'method': 'PUT',
              'params': {'uploadType': 'multipart'},
              'headers': {
                'Content-Type': 'multipart/mixed; boundary="' + boundary + '"'
              },
              'body': multipartRequestBody});
          return gQ(request).then(makeFile);
        },
        _googObj: googFileObject
      };
    }

    var api = {
      getFileById: function(id) {
        return gQ(drive.files.get({fileId: id})).then(makeFile);
      },
      getSharedFileById: function(id) {
        return gQ(drive.files.get({fileId: id})).then(makeSharedFile);
      },
      getAllFiles: function() {
        return baseCollection.then(function(bc) {
          return gQ(drive.files.list({ q: "trashed=false and '" + bc.id + "' in parents" }))
          .then(function(filesResult) {
            if(!filesResult.items) { return []; }
            return filesResult.items.map(makeFile);
          });
        });
      },
      createFile: function(name) {
        return baseCollection.then(function(bc) {
          var request = 
            gapi.client.request({
              'path': '/drive/v2/files',
              'method': 'POST',
              'params': {},
              'body': {
                "parents": [{id: bc.id}],
                "mimeType": "text/plain",
                "fileExtension": "arr",
                "title": name
              }
            });
          return gQ(request).then(makeFile);
        });
      }
    };

    function findOrCreateShareDirectory() {
      var shareCollectionName = collectionName + ".shared";
      var filesReq = gQ(drive.files.list({
          q: "trashed=false and title = '" + shareCollectionName + "' and "+
             "mimeType = '" + FOLDER_MIME + "'"
        }));
      var collection = filesReq.then(function(files) {
        if(files.items && files.items.length > 0) {
          return files.items[0];
        }
        else {
          var dir = gQ(drive.files.insert({
            resource: {
              mimeType: FOLDER_MIME,
              title: shareCollectionName
            }
          }));
          var perm = dir.then(function(d) {
            return gQ(drive.permissions.insert({
              fileId: d.id,
              resource: {
                'role': 'reader',
                'type': 'anyone',
                'id': d.permissionId
              }
            }));
          });
          return perm.then(function(_) { return dir; });
        }
      });
      return collection;
    }

    return {
      api: api,
      collection: baseCollection,
      reinitialize: function() {
        return Q.fcall(function() { return initialize(); });
      }
    }
  }

  function initialize() {
    drive = gapi.client.drive;

    var list = gQ(drive.files.list({}));
    var baseCollection = list.then(function(filesResult) {
      var foundCollection = false;
      if(filesResult.items) {
        filesResult.items.forEach(function(i) {
          if(i.mimeType === FOLDER_MIME &&
             i.title === collectionName &&
             !(i.explicitlyTrashed)) {
            foundCollection = i;
          }
        });
      }
      var baseCollection;
      if(!foundCollection) {
        return gQ(
            drive.files.insert({
              resource: {
                mimeType: "application/vnd.google-apps.folder",
                title: collectionName
              }
            }));
      }
      else {
        return foundCollection;
      }
    });
    var fileList = list.then(function(fr) { return fr.items || []; });
    return createAPI(baseCollection);
  }

  var reauth = function(immediate) {
    var d = Q.defer();
    gapi.auth.authorize({client_id: clientId, scope: SCOPE, immediate: immediate}, function(authResult) {
      if(!authResult || authResult.error) {
        d.resolve(null);
      }
      else {
        d.resolve(authResult);
      }
    });
    return d.promise;
  };

  var initialAuth = reauth(immediate);
  return initialAuth.then(function(_) {
    var d = Q.defer();
    gapi.client.load('drive', 'v2', function() {
      d.resolve(initialize())
    });
    return d.promise;
  });
  return initialAuth;
}