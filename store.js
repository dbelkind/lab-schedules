// All reads and writes to Firebase live here.
const Store = (() => {
  let auth;
  let db;

  const withId = (doc) => ({ id: doc.id, ...doc.data() });

  async function listAll(collection, ownerEmail) {
    const ref = db.collection(collection);
    const query = ownerEmail ? ref.where("ownerEmail", "==", ownerEmail) : ref;
    return (await query.get()).docs.map(withId);
  }

  return {
    isConfigured() {
      return Boolean(FIREBASE_CONFIG.projectId && window.firebase);
    },

    onAuthChange(callback) {
      firebase.initializeApp(FIREBASE_CONFIG);
      auth = firebase.auth();
      db = firebase.firestore();
      auth.onAuthStateChanged(callback);
    },

    signIn() {
      return auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    },

    signOut() {
      return auth.signOut();
    },

    async getMember(email) {
      const doc = await db.collection("members").doc(email).get();
      return doc.exists ? { email: doc.id, ...doc.data() } : null;
    },

    async listMembers() {
      return (await db.collection("members").get()).docs.map((doc) => ({ email: doc.id, ...doc.data() }));
    },

    // Lab members can't see the lab list, only who the reviewers are, so bookers can email them and the site can say
    // who's emailed about what someone does.
    async listReviewers() {
      return (await db.collection("members").where("role", "==", "reviewer").get()).docs.map((doc) => ({ email: doc.id, ...doc.data() }));
    },

    // Pass an email to get one person's entries. Only reviewers may leave it out.
    listAvailability: (ownerEmail) => listAll("availability", ownerEmail),
    listTimeOff: (ownerEmail) => listAll("timeOff", ownerEmail),

    saveAvailability(id, data) {
      const ref = db.collection("availability");
      return id ? ref.doc(id).set(data) : ref.add(data);
    },

    // Applies a set of schedule changes at once, so a failure can't leave them half saved.
    applyClassPlan({ creates = [], updates = [], deletes = [] }) {
      const batch = db.batch();
      const ref = db.collection("availability");
      for (const data of creates) batch.set(ref.doc(), data);
      for (const { id, data } of updates) batch.set(ref.doc(id), data);
      for (const id of deletes) batch.delete(ref.doc(id));
      return batch.commit();
    },

    listChangeRequests: (ownerEmail) => listAll("changeRequests", ownerEmail),

    // The semesters someone has said they have no classes in, so they aren't reminded to add a class schedule.
    // Reviewers get everyone's; anyone else only their own.
    async listNoClasses(email) {
      if (email) {
        const doc = await db.collection("noClasses").doc(email).get();
        return doc.exists ? [{ email, ...doc.data() }] : [];
      }
      return (await db.collection("noClasses").get()).docs.map((doc) => ({ email: doc.id, ...doc.data() }));
    },
    saveNoClasses: (email, semesters) => db.collection("noClasses").doc(email).set({ semesters }),

    // Calls back with how many time off requests and schedule changes are waiting, now and whenever that changes.
    // Returns a function that stops watching. Only reviewers can do this.
    watchPending(onCount) {
      const counts = { timeOff: 0, changeRequests: 0 };
      const watch = (collection) => db.collection(collection).where("status", "==", "pending").onSnapshot((snapshot) => {
        counts[collection] = snapshot.size;
        onCount(counts.timeOff + counts.changeRequests);
      }, () => {});
      const stops = [watch("timeOff"), watch("changeRequests")];
      return () => stops.forEach((stop) => stop());
    },
    // An id for a new document, made before it's saved so an email choice can point to it.
    newId: (collection) => db.collection(collection).doc().id,

    // Tells reviewers about a Grad Student/Post-Doc's change; the Apps Script emails these and then deletes them.
    createNotice: (data, id) => (id ? db.collection("notices").doc(id).set(data) : db.collection("notices").add(data)),
    createChangeRequest: (data, id) => (id ? db.collection("changeRequests").doc(id).set(data) : db.collection("changeRequests").add(data)),

    // Who to leave off, and any message for, the email about something someone just did. The Apps Script reads these
    // when it sends that email, then deletes them.
    saveEmailChoice: (id, data) => db.collection("emailChoices").doc(id).set(data),
    deleteChangeRequest: (id) => db.collection("changeRequests").doc(id).delete(),
    decideChangeRequest: (id, decision) => db.collection("changeRequests").doc(id).update(decision),

    // Approving applies the change and records the decision together.
    approveChangeRequest(id, { creates, updates, deletes }, decision) {
      const batch = db.batch();
      const ref = db.collection("availability");
      for (const data of creates) batch.set(ref.doc(), data);
      for (const { id: entryId, data } of updates) batch.set(ref.doc(entryId), data);
      for (const entryId of deletes) batch.delete(ref.doc(entryId));
      batch.update(db.collection("changeRequests").doc(id), decision);
      return batch.commit();
    },

    async listAppointments() {
      return (await db.collection("appointments").get()).docs.map(withId);
    },

    // A change to a default visit is saved under a fixed id for its date, so there's only ever one per day.
    saveAppointment(appointment, data) {
      const ref = db.collection("appointments");
      if (appointment.id) return ref.doc(appointment.id).set(data);
      if (appointment.defaultFor) return ref.doc(`default-${appointment.defaultFor}`).set(data);
      return ref.add(data);
    },

    deleteAppointment: (id) => db.collection("appointments").doc(id).delete(),

    // Booking only touches the booking fields. A default visit nobody has changed yet is saved as it is, plus the booking.
    bookVisit(appointment, fields) {
      const ref = db.collection("appointments");
      if (appointment.id) return ref.doc(appointment.id).update(fields);
      return ref.doc(`default-${appointment.defaultFor}`).set({
        date: appointment.date,
        defaultFor: appointment.defaultFor,
        cancelled: false,
        lab: appointment.lab,
        scan: appointment.scan,
        ...fields,
      });
    },

    // The USC academic calendar and staff holidays as lab managers last saved them, or null for either not saved yet.
    async getSettings() {
      const [academic, holidays] = await Promise.all(["academicCalendar", "staffHolidays"].map((name) => db.collection("settings").doc(name).get()));
      return { academic: academic.exists ? academic.data() : null, holidays: holidays.exists ? holidays.data() : null };
    },
    saveSetting: (name, data) => db.collection("settings").doc(name).set(data),

    // The lab directory (name, directory role and phone), which everyone in the lab can see.
    listDirectory: async () => (await db.collection("directory").get()).docs.map((doc) => ({ email: doc.id, ...doc.data() })),
    saveDirectory: (email, data) => db.collection("directory").doc(email).set(data, { merge: true }),
    // Takes a phone number out of someone's directory entry, as when it moves to directoryPrivate.
    clearDirectoryPhone: (email) => db.collection("directory").doc(email).update({ phone: firebase.firestore.FieldValue.delete() }),

    // A PI's phone number, kept apart so RAs can't see it. Only Grad Students/Post-Docs and reviewers can read these.
    listPrivatePhones: async () => (await db.collection("directoryPrivate").get()).docs.map((doc) => ({ email: doc.id, ...doc.data() })),
    savePrivatePhone: (email, phone) => db.collection("directoryPrivate").doc(email).set({ phone }),
    deletePrivatePhone: (email) => db.collection("directoryPrivate").doc(email).delete(),

    // Birthdays, graduation and favorites, which only the person and lab managers can see.
    async getProfile(email) {
      const doc = await db.collection("profiles").doc(email).get();
      return doc.exists ? doc.data() : null;
    },
    listProfiles: async () => (await db.collection("profiles").get()).docs.map((doc) => ({ email: doc.id, ...doc.data() })),
    saveProfile: (email, data) => db.collection("profiles").doc(email).set(data),

    // The Staffing calendar's days whose reference slots were changed, one per date. Only reviewers use these.
    listReferenceDays: () => listAll("referenceSlots"),
    saveReferenceDay: (iso, data) => db.collection("referenceSlots").doc(iso).set(data),
    deleteReferenceDay: (iso) => db.collection("referenceSlots").doc(iso).delete(),

    // Who is staffing each visit, saved under the visit's key. Only reviewers can read or change these.
    listStaffing: () => listAll("staffing"),
    saveStaffing: (key, data) => db.collection("staffing").doc(key).set(data),
    deleteStaffing: (key) => db.collection("staffing").doc(key).delete(),

    deleteAvailability: (id) => db.collection("availability").doc(id).delete(),

    saveTimeOff(id, data) {
      const ref = db.collection("timeOff");
      return id ? ref.doc(id).set(data) : ref.add(data);
    },

    deleteTimeOff: (id) => db.collection("timeOff").doc(id).delete(),

    decideTimeOff(id, decision) {
      return db.collection("timeOff").doc(id).update(decision);
    },

    saveMember(email, data) {
      return db.collection("members").doc(email).set(data);
    },

    // Removing someone also removes their schedule, directory entry and profile, so nothing of theirs is left behind.
    async deleteMember(email) {
      const [availability, timeOff, changes] = await Promise.all([
        listAll("availability", email),
        listAll("timeOff", email),
        listAll("changeRequests", email),
      ]);
      const batch = db.batch();
      for (const { id } of availability) batch.delete(db.collection("availability").doc(id));
      for (const { id } of timeOff) batch.delete(db.collection("timeOff").doc(id));
      for (const { id } of changes) batch.delete(db.collection("changeRequests").doc(id));
      batch.delete(db.collection("directory").doc(email));
      batch.delete(db.collection("directoryPrivate").doc(email));
      batch.delete(db.collection("profiles").doc(email));
      batch.delete(db.collection("members").doc(email));
      return batch.commit();
    },
  };
})();
