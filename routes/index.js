
/*
 * GET home page.
 */

exports.index = function(req, res){
  res.render('ID.html', { title: 'Cloudant Boiler Plate' });
};