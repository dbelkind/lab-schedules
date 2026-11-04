// From the Firebase console: Project settings > Your apps > Web app.
// These values identify the project and are safe to publish; firestore.rules is what protects the data.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBDJhBd32VEa9N7O6R5FJEaANR_KZeF9mk",
  authDomain: "lab-schedules.firebaseapp.com",
  projectId: "lab-schedules",
  appId: "1:1028767888591:web:6840673d59d100dac7f3ba",
};

// The Apps Script's web app URL (in Apps Script: Deploy > Manage deployments), so the site can ask it to update
// LCL Visits and send cancellation emails straight away after a change. Left empty, they happen every 10 minutes.
const SYNC_URL = "https://script.google.com/macros/s/AKfycbw6GgI6jDw8CkqsgupFlP3xeEuflgCPv2u5CrUlZssQKbof7Y8hj5boU8KdFWtsCNO1Nw/exec";
