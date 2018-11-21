/**
 * Module dependencies.
 */

var express = require('express'),
    routes = require('./routes'),
    user = require('./routes/user'),
    http = require('http'),
    path = require('path'),
    fs = require('fs'),
    cfenv = require('cfenv');

var app = express();

var db;

var cloudant;

var fileToUpload;

var dbCredentials = {
    dbName: 'public'
};



const session = require("express-session");
const passport = require("passport");
const nconf = require("nconf");
const appID = require("ibmcloud-appid");


const helmet = require("helmet");
const express_enforces_ssl = require("express-enforces-ssl");
const cookieParser = require("cookie-parser");
const flash = require("connect-flash");

const WebAppStrategy = appID.WebAppStrategy;
const userProfileManager = appID.UserProfileManager;
const UnauthorizedException = appID.UnauthorizedException;


const GUEST_USER_HINT = "A guest user started using the app. App ID created a new anonymous profile, where the user’s selections can be stored.";
const RETURNING_USER_HINT = "An identified user returned to the app with the same identity. The app accesses his identified profile and the previous selections that he made.";
const NEW_USER_HINT = "An identified user logged in for the first time. Now when he logs in with the same credentials from any device or web client, the app will show his same profile and selections.";

const LOGIN_URL = "/ibm/bluemix/appid/login";
const CALLBACK_URL = "/ibm/bluemix/appid/callback";

const port = process.env.PORT || 3011;

const isLocal = cfenv.getAppEnv().isLocal;

const config = getLocalConfig();
configureSecurity();

app.use(flash());



var bodyParser = require('body-parser');
var methodOverride = require('method-override');
var logger = require('morgan');
var errorHandler = require('errorhandler');
var multipart = require('connect-multiparty')
var multipartMiddleware = multipart();

// all environments
//app.set('port', process.env.PORT || 302);
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.engine('html', require('ejs').renderFile);
app.use(logger('dev'));
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(bodyParser.json());
app.use(methodOverride());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/style', express.static(path.join(__dirname, '/views/style')));

// development only
if ('development' == app.get('env')) {
    app.use(errorHandler());
}




















// Setup express application to use express-session middleware
// Must be configured with proper session storage for production
// environments. See https://github.com/expressjs/session for
// additional documentation
app.use(session({
  secret: "123456",
  resave: true,
  saveUninitialized: true,
    proxy: true,
    cookie: {
        httpOnly: true,
        secure: !isLocal
    }
}));

//app.set('view engine', 'ejs');

// Configure express application to use passportjs
app.use(passport.initialize());
app.use(passport.session());

let webAppStrategy = new WebAppStrategy(config);
passport.use(webAppStrategy);

// Initialize the user attribute Manager
userProfileManager.init(config);



// Configure passportjs with user serialization/deserialization. This is required
// for authenticated session persistence accross HTTP requests. See passportjs docs
// for additional information http://passportjs.org/docs
passport.serializeUser(function(user, cb) {
                
                       if (user.amr[0]== 'cloud_directory'){
                       dbCredentials = {
                       
                       dbName: "a"+user.sub
                       };
                       
                       }else {
                       
                       dbCredentials = {
                       
                       dbName: "public"
                       };
                       }
                       
                       initDBConnection();
                       
  cb(null, user);
});

passport.deserializeUser(function(obj, cb) {
  cb(null, obj);
});

// Explicit login endpoint. Will always redirect browser to login widget due to {forceLogin: true}.
// If forceLogin is set to false redirect to login widget will not occur of already authenticated users.
app.get(LOGIN_URL, passport.authenticate(WebAppStrategy.STRATEGY_NAME, {
  forceLogin: true
}));

// Callback to finish the authorization process. Will retrieve access and identity tokens/
// from AppID service and redirect to either (in below order)
// 1. the original URL of the request that triggered authentication, as persisted in HTTP session under WebAppStrategy.ORIGINAL_URL key.
// 2. successRedirect as specified in passport.authenticate(name, {successRedirect: "...."}) invocation
// 3. application root ("/")
app.get(CALLBACK_URL, passport.authenticate(WebAppStrategy.STRATEGY_NAME, {failureRedirect: '/error' ,failureFlash: true ,allowAnonymousLogin: true}));

function storeRefreshTokenInCookie(req, res, next) {
    if (req.session[WebAppStrategy.AUTH_CONTEXT] && req.session[WebAppStrategy.AUTH_CONTEXT].refreshToken) {
        const refreshToken = req.session[WebAppStrategy.AUTH_CONTEXT].refreshToken;
        /* An example of storing user's refresh-token in a cookie with expiration of a month */
        res.cookie('refreshToken', refreshToken, {maxAge: 1000 * 60 * 60 * 24 * 30 /* 30 days */});
    }
    next();
}

function isLoggedIn(req) {

    return req.session[WebAppStrategy.AUTH_CONTEXT];
}

// Protected area. If current user is not authenticated - redirect to the login widget will be returned.
// In case user is authenticated - a page with current user information will be returned.
app.get("/IBMCloud.html", function tryToRefreshTokensIfNotLoggedIn(req, res, next) {
    if (isLoggedIn(req)) {
        return next();
    }

    webAppStrategy.refreshTokens(req, req.cookies.refreshToken).finally(function() {
        next();
    });
}, passport.authenticate(WebAppStrategy.STRATEGY_NAME), storeRefreshTokenInCookie, function (req, res, next) {
    var accessToken = req.session[WebAppStrategy.AUTH_CONTEXT].accessToken;
    var isGuest = req.user.amr[0] === "appid_anon";
    var isCD = req.user.amr[0] === "cloud_directory";
    var foodSelection;
    var firstLogin;
    // get the attributes for the current user:
    userProfileManager.getAllAttributes(accessToken).then(function (attributes) {
        var toggledItem = req.query.foodItem;

        foodSelection = attributes.foodSelection ? JSON.parse(attributes.foodSelection) : [];
                                                          
                                                        
        firstLogin = !isGuest && !attributes.points;
        if (!toggledItem) {
            return;
        }
        var selectedItemIndex = foodSelection.indexOf(toggledItem);
        if (selectedItemIndex >= 0) {
            foodSelection.splice(selectedItemIndex, 1);
        } else {
            foodSelection.push(toggledItem);
        }
        // update the user's selection
        return userProfileManager.setAttribute(accessToken, "foodSelection", JSON.stringify(foodSelection));
    }).then(function () {
        givePointsAndRenderPage(req, res, foodSelection, isGuest, isCD, firstLogin);
    }).catch(function (e) {
        next(e);
    });
});

// Protected area. If current user is not authenticated - an anonymous login process will trigger.
// In case user is authenticated - a page with current user information will be returned.
app.get("/anon_login", passport.authenticate(WebAppStrategy.STRATEGY_NAME, {allowAnonymousLogin: true, successRedirect : '/IBMCloud.html', forceLogin: true}));

// Protected area. If current user is not authenticated - redirect to the login widget will be returned.
// In case user is authenticated - a page with current user information will be returned.
app.get("/login", passport.authenticate(WebAppStrategy.STRATEGY_NAME, {successRedirect : '/IBMCloud.html', forceLogin: true}));

app.get("/logout", function(req, res, next) {
    WebAppStrategy.logout(req);
    // If you chose to store your refresh-token, don't forgot to clear it also in logout:
    res.clearCookie("refreshToken");
    res.redirect("/");
});


app.get("/token", function(req, res){
    //return the token data
    res.render('token',{tokens: JSON.stringify(req.session[WebAppStrategy.AUTH_CONTEXT])});
});

app.get("/userInfo", passport.authenticate(WebAppStrategy.STRATEGY_NAME), function(req, res) {
    //return the user info data
    userProfileManager.getUserInfo(req.session[WebAppStrategy.AUTH_CONTEXT].accessToken).then(function (userInfo) {
        res.render('userInfo', {userInfo: JSON.stringify(userInfo)});
    }).catch(function() {
        res.render('infoError');
    })
});

app.get('/error', function(req, res) {
    let errorArray = req.flash('error');
    res.render("error.ejs",{errorMessage: errorArray[0]});
});

app.get("/change_password", passport.authenticate(WebAppStrategy.STRATEGY_NAME, {
    successRedirect: '/IBMCloud.html',
    show: WebAppStrategy.CHANGE_PASSWORD
}));

app.get("/change_details", passport.authenticate(WebAppStrategy.STRATEGY_NAME, {
    successRedirect: '/IBMCloud.html',
    show: WebAppStrategy.CHANGE_DETAILS
}));


app.use(express.static("public", {index: null}));

/*
app.use('/', function(req, res, next) {
    if (!isLoggedIn(req)) {
        console.log("hello I'99");
        webAppStrategy.refreshTokens(req, req.cookies.refreshToken).then(function() {
            res.redirect('/public/IBMCloud.html');
        }).catch(function() {
            next();
        })
    } else {
        console.log("hello I'88");
        //next();
        res.redirect('/public/IBMCloud.html');
        //initDBConnection();
        

    }
}, function(req,res,next) {
        
        
        console.log("hello I'77");
        //next();
        //res.redirect('/public/index.html');
    //res.sendFile(__dirname + '/views/ID.html');
        res.sendFile(__dirname + '/public/index.html');
        //res.sendFile(__dirname + '/index.html');
});

 /*/
//app.use(express.static(path.join(__dirname, 'public')));


app.use(function(err, req, res, next) {
    if (err instanceof UnauthorizedException) {
        WebAppStrategy.logout(req);
        res.redirect('/');
    } else {
        next(err);
    }
});



app.listen(port, function(req){
  console.log("Listening on http://localhost:" + port);
});


function givePointsAndRenderPage(req, res, foodSelection, isGuest, isCD, firstLogin) {
    //return the protected page with user info
    var hintText;
    if (isGuest) {
        hintText = GUEST_USER_HINT;
    } else {
        if (firstLogin) {
            hintText = NEW_USER_HINT;
        } else {
            hintText = RETURNING_USER_HINT;
        }
    }
    var email = req.user.email;
    if(req.user.email !== undefined && req.user.email.indexOf('@') != -1){
        email = req.user.email.substr(0,req.user.email.indexOf('@'));
    }
    var renderOptions = {
        name: req.user.name || email || "Guest",
        picture: req.user.picture || "/images/anonymous.svg",
        foodSelection: JSON.stringify(foodSelection),
        topHintText: isGuest ? "Login to get a gift >" : "You got 150 points go get a pizza",
        topImageVisible : isGuest ? "hidden" : "visible",
        topHintClickAction : isGuest ? ' window.location.href = "/login";' : ";",
        hintText,
        isGuest,
        isCD
    };

    if (firstLogin) {
        userProfileManager.setAttribute(req.session[WebAppStrategy.AUTH_CONTEXT].accessToken, "points", "150").then(function (attributes) {
            res.render('IBMCloud.html', renderOptions);
        });
    } else {
      res.render('IBMCloud.html', renderOptions);
    }
}


function getLocalConfig() {
    if (!isLocal) {
        return {};
    }
    let config = {};
    const localConfig = nconf.env().file(`${__dirname}/localdev-config.json`).get();
    const requiredParams = ['clientId', 'secret', 'tenantId', 'oauthServerUrl', 'profilesUrl'];
    requiredParams.forEach(function (requiredParam) {
        if (!localConfig[requiredParam]) {
            console.error('When running locally, make sure to create a file *localdev-config.json* in the root directory. See config.template.json for an example of a configuration file.');
            console.error(`Required parameter is missing: ${requiredParam}`);
            process.exit(1);
        }
        config[requiredParam] = localConfig[requiredParam];
    });
    config['redirectUri'] = `http://localhost:${port}${CALLBACK_URL}`;
    return config;
}

function configureSecurity() {
    app.use(helmet());
    app.use(cookieParser());
    app.use(helmet.noCache());
    app.enable("trust proxy");
    if (!isLocal) {
        app.use(express_enforces_ssl());
    }
}



























function getDBCredentialsUrl(jsonData) {
    var vcapServices = JSON.parse(jsonData);
    // Pattern match to find the first instance of a Cloudant service in
    // VCAP_SERVICES. If you know your service key, you can access the
    // service credentials directly by using the vcapServices object.
    for (var vcapService in vcapServices) {
        if (vcapService.match(/cloudant/i)) {
            return vcapServices[vcapService][0].credentials.url;
        }
    }
}

function initDBConnection() {
    //When running on Bluemix, this variable will be set to a json object
    //containing all the service credentials of all the bound services
    if (process.env.VCAP_SERVICES) {
        dbCredentials.url = getDBCredentialsUrl(process.env.VCAP_SERVICES);
    } else { //When running locally, the VCAP_SERVICES will not be set

        // When running this app locally you can get your Cloudant credentials
        // from Bluemix (VCAP_SERVICES in "cf env" output or the Environment
        // Variables section for an app in the Bluemix console dashboard).
        // Once you have the credentials, paste them into a file called vcap-local.json.
        // Alternately you could point to a local database here instead of a
        // Bluemix service.
        // url will be in this format: https://username:password@xxxxxxxxx-bluemix.cloudant.com
        dbCredentials.url = getDBCredentialsUrl(fs.readFileSync("vcap-local.json", "utf-8"));
    }


// load local VCAP configuration  and service credentials
var vcapLocal;
try {
  vcapLocal = require('./vcap-local.json');
  console.log("Loaded local VCAP", vcapLocal);
    
} catch (e) { }

const appEnvOpts = vcapLocal ? { vcap: vcapLocal} : {}

const appEnv = cfenv.getAppEnv(appEnvOpts);


// Load the Cloudant library.
var Cloudant = require('@cloudant/cloudant');
if (appEnv.services['cloudantNoSQLDB'] || appEnv.getService(/cloudant/)) {

  // Initialize database with credentials
  if (appEnv.services['cloudantNoSQLDB']) {
    // CF service named 'cloudantNoSQLDB'
    cloudant = Cloudant(appEnv.services['cloudantNoSQLDB'][0].credentials);
  } else {
     // user-provided service with 'cloudant' in its name
     cloudant = Cloudant(appEnv.getService(/cloudant/).credentials);
  }
} else if (process.env.CLOUDANT_URL){
  cloudant = Cloudant(process.env.CLOUDANT_URL);
}

if(cloudant) {
  //database name
  var dbName = 'mydbM';

  // Create a new "mydb" database.
  cloudant.db.create(dbName, function(err, data) {
    if(!err) //err if database doesn't already exists
      console.log("Created database: " + dbName);
  });

  // Specify the database we are going to use (mydb)...
  db = cloudant.db.use(dbName);
}

    
    
    //cloudant = require('cloudant')(dbCredentials.url);

    // check if DB exists if not create
    cloudant.db.create(dbCredentials.dbName, function(err, res) {
        if (err) {
            console.log('Could not create new db: ' + dbCredentials.dbName + ', it might already exist.');
        }
    });

    db = cloudant.use(dbCredentials.dbName);



}

//initDBConnection();

//app.get('/', routes.index);

function createResponseData(id, name, value, attachments) {

    var responseData = {
        id: id,
        name: sanitizeInput(name),
        value: sanitizeInput(value),
        attachements: []
    };


    attachments.forEach(function(item, index) {
        var attachmentData = {
            content_type: item.type,
            key: item.key,
            url: 'api/favorites/attach?id=' + id + '&key=' + item.key
        };
        responseData.attachements.push(attachmentData);

    });
    return responseData;
}

function sanitizeInput(str) {
    return String(str).replace(/&(?!amp;|lt;|gt;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var saveDocument = function(id, name, value, response) {

    if (id === undefined) {
        // Generated random id
        id = '';
    }

    db.insert({
        name: name,
        value: value
    }, id, function(err, doc) {
        if (err) {
            console.log(err);
            response.sendStatus(500);
        } else
            response.sendStatus(200);
        response.end();
    });

}

app.get('/api/favorites/attach', function(request, response) {
    var doc = request.query.id;
    var key = request.query.key;

    db.attachment.get(doc, key, function(err, body) {
        if (err) {
            response.status(500);
            response.setHeader('Content-Type', 'text/plain');
            response.write('Error: ' + err);
            response.end();
            return;
        }

        response.status(200);
        response.setHeader("Content-Disposition", 'inline; filename="' + key + '"');
        response.write(body);
        response.end();
        return;
    });
});

app.post('/api/favorites/attach', multipartMiddleware, function(request, response) {

    console.log("Upload File Invoked..");
    console.log('Request: ' + JSON.stringify(request.headers));

    var id;

    db.get(request.query.id, function(err, existingdoc) {

        var isExistingDoc = false;
        if (!existingdoc) {
            id = '-1';
        } else {
            id = existingdoc.id;
            isExistingDoc = true;
        }

        var name = sanitizeInput(request.query.name);
        var value = sanitizeInput(request.query.value);

        var file = request.files.file;
        var newPath = './public/uploads/' + file.name;

        var insertAttachment = function(file, id, rev, name, value, response) {

            fs.readFile(file.path, function(err, data) {
                if (!err) {

                    if (file) {

                        db.attachment.insert(id, file.name, data, file.type, {
                            rev: rev
                        }, function(err, document) {
                            if (!err) {
                                console.log('Attachment saved successfully.. ');

                                db.get(document.id, function(err, doc) {
                                    console.log('Attachements from server --> ' + JSON.stringify(doc._attachments));

                                    var attachements = [];
                                    var attachData;
                                    for (var attachment in doc._attachments) {
                                        if (attachment == value) {
                                            attachData = {
                                                "key": attachment,
                                                "type": file.type
                                            };
                                        } else {
                                            attachData = {
                                                "key": attachment,
                                                "type": doc._attachments[attachment]['content_type']
                                            };
                                        }
                                        attachements.push(attachData);
                                    }
                                    var responseData = createResponseData(
                                        id,
                                        name,
                                        value,
                                        attachements);
                                    console.log('Response after attachment: \n' + JSON.stringify(responseData));
                                    response.write(JSON.stringify(responseData));
                                    response.end();
                                    return;
                                });
                            } else {
                                console.log(err);
                            }
                        });
                    }
                }
            });
        }

        if (!isExistingDoc) {
            existingdoc = {
                name: name,
                value: value,
                create_date: new Date()
            };

            // save doc
            db.insert({
                name: name,
                value: value
            }, '', function(err, doc) {
                if (err) {
                    console.log(err);
                } else {

                    existingdoc = doc;
                    console.log("New doc created ..");
                    console.log(existingdoc);
                    insertAttachment(file, existingdoc.id, existingdoc.rev, name, value, response);

                }
            });

        } else {
            console.log('Adding attachment to existing doc.');
            console.log(existingdoc);
            insertAttachment(file, existingdoc._id, existingdoc._rev, name, value, response);
        }

    });

});

app.post('/api/favorites', function(request, response) {

    console.log("Create Invoked..");
    console.log("Name: " + request.body.name);
    console.log("Value: " + request.body.value);

    // var id = request.body.id;
    var name = sanitizeInput(request.body.name);
    var value = sanitizeInput(request.body.value);

    saveDocument(null, name, value, response);

});

app.delete('/api/favorites', function(request, response) {

    console.log("Delete Invoked..");
    var id = request.query.id;
    // var rev = request.query.rev; // Rev can be fetched from request. if
    // needed, send the rev from client
    console.log("Removing document of ID: " + id);
    console.log('Request Query: ' + JSON.stringify(request.query));

    db.get(id, {
        revs_info: true
    }, function(err, doc) {
        if (!err) {
            db.destroy(doc._id, doc._rev, function(err, res) {
                // Handle response
                if (err) {
                    console.log(err);
                    response.sendStatus(500);
                } else {
                    response.sendStatus(200);
                }
            });
        }
    });

});

app.put('/api/favorites', function(request, response) {

    console.log("Update Invoked..");

    var id = request.body.id;
    var name = sanitizeInput(request.body.name);
    var value = sanitizeInput(request.body.value);

    console.log("ID: " + id);

    db.get(id, {
        revs_info: true
    }, function(err, doc) {
        if (!err) {
            console.log(doc);
            doc.name = name;
            doc.value = value;
            db.insert(doc, doc.id, function(err, doc) {
                if (err) {
                    console.log('Error inserting data\n' + err);
                    return 500;
                }
                return 200;
            });
        }
    });
});

app.get('/api/favorites', function(request, response, next) {

    console.log("Get method invoked.. ")
      
        
        
        if (!isLoggedIn(request)) {
        
        dbCredentials = {
        
        dbName: "public"
        };
        
        } else {
        
        
        if (request.user.amr[0]== 'cloud_directory'){
        
        dbCredentials = {
        
        dbName: "a"+request.user.sub
        
        };
       
        }else {
        
        dbCredentials = {
        
        dbName: "public"
        };
        }
        
        }
        
        
        
        
        
        
        
    db = cloudant.use(dbCredentials.dbName);
    var docList = [];
    var i = 0;
    db.list(function(err, body) {
        if (!err) {
            var len = body.rows.length;
            
            console.log('total # of docs -> ' + len);
            if (len == 0) {
                // push sample data
                // save doc
                var docName = 'sample_doc';
                var docDesc = 'A sample Document';
                db.insert({
                    name: docName,
                    value: 'A sample Document'
                }, '', function(err, doc) {
                    if (err) {
                        console.log(err);
                    } else {

                        console.log('Document : ' + JSON.stringify(doc));
                        var responseData = createResponseData(
                            doc.id,
                            docName,
                            docDesc, []);
                        docList.push(responseData);
                        response.write(JSON.stringify(docList));
                        console.log(JSON.stringify(docList));
                        console.log('ending response...');
                        response.end();
                    }
                });
            } else {

                body.rows.forEach(function(document) {

                    db.get(document.id, {
                        revs_info: true
                    }, function(err, doc) {
                        if (!err) {
                            if (doc['_attachments']) {

                                var attachments = [];
                                for (var attribute in doc['_attachments']) {

                                    if (doc['_attachments'][attribute] && doc['_attachments'][attribute]['content_type']) {
                                        attachments.push({
                                            "key": attribute,
                                            "type": doc['_attachments'][attribute]['content_type']
                                        });
                                    }
                                    console.log(attribute + ": " + JSON.stringify(doc['_attachments'][attribute]));
                                }
                                var responseData = createResponseData(
                                    doc._id,
                                    doc.name,
                                    doc.value,
                                    attachments);

                            } else {
                                var responseData = createResponseData(
                                    doc._id,
                                    doc.name,
                                    doc.value, []);
                            }

                            docList.push(responseData);
                            i++;
                            if (i >= len) {
                                response.write(JSON.stringify(docList));
                                console.log('ending response...');
                                response.end();
                            }
                        } else {
                            console.log(err);
                        }
                    });

                });
            }

        } else {
            console.log(err);
        }
    });

});
