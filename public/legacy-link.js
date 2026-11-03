// Share links from before the app moved to /app/ put the meeting in the root URL's fragment.
if (/(^#|&)b=/.test(location.hash)) location.replace('/app/' + location.hash);
