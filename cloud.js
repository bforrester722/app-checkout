/**
  *
  * inventory:
  * 
  *   each item must have an inventoryAdjust obj with coll, doc, field props
  * 
  *   ie. item === {
  *         ...
  *         inventoryAdjust: {
  *           coll,
  *           doc,
  *           field, // can use dot notation here to access nested objects ie. 'foil.Near Mint.qty',
  *           val    // number to take out of inventory
  *         }
  *         ...
  *       }
  *   
  * shipping:
  * 
  *   each item must have amount, description, displayName, shipping props
  *
  *   ie. item === {
  *         ...
  *         amount,       (msrp)
  *         description,  (short item description)
  *         displayName,  (human readable string)
  *         shipping: {
  *           height,     (cm)
  *           length,     (cm)
  *           weight,     (kg)
  *           width,      (cm)
  *         }
  *         ...
  *       }
  *
  * pay:
  *
  *   each item must have amount, displayName props
  *
  *   ie. item === {
  *         ...
  *         amount,      (msrp)
  *         displayName, (human readable string)
  *         ...
  *       }
  *
  **/


'use strict';


const sendgrid   = require('@sendgrid/mail');
const braintree  = require('braintree');
const initShippo = require('./cloud-shippo');


const initGateway = (env, opts) => {
  const {Production, Sandbox} = braintree.Environment;
  const environment = env === 'production' ? Production : Sandbox;
  const {merchantId, privateKey, publicKey} = opts[env];
  // returns a gateway
  return braintree.connect({
    environment,
    merchantId,
    privateKey,
    publicKey
  });
};
// completeOrder helper
// send branded payment receipt to customer
const receipt = dependencies => async (order, transaction) => {
  try {
    const {
      business, 
      receiptEmail, 
      receiptTemplate
    } = dependencies;
    const {
      address, 
      amount,
      credit,
      date, 
      email, 
      fullName, 
      items, 
      orderId,
      orderType,
      shippingCost, 
      subtotal, 
      tax
    } = order;
    const itemRows = items.map(item => {
      const {amount, displayName, orderQty} = item;
      const price = Number(amount).
        toFixed(2).
        toLocaleString(undefined, {style: 'currency', currency: 'USD'});
      return Object.assign({}, item, {displayName, orderQty, price}); // email template data bindings
    });
    // address present if there are shipping items,
    // otherwise fullName will be used for name and other 
    // shipping props will not be used
    const getUserData = (addr, name) => addr ? addr : {name};
    const {
      name, 
      street1,
      street2, 
      city, 
      state, 
      zip, 
      country, 
      phone
    } = getUserData(address, fullName);
    const {
      amount: transactionAmount,
      creditCard,
      processorAuthorizationCode,
      processorResponseText
    } = transaction;
    // there's no transaction and thus no creditCard for pickup orders
    const {cardType, cardholderName, last4} = creditCard ? creditCard : {};
    const total = transactionAmount ? transactionAmount : amount;
    const formattedStreet2 = street2 ? ` ${street2}` : '';
    const msg = {
      to:          email,
      bcc:         receiptEmail,
      from:        business.address.email,
      subject:    `${business.address.name} Receipt`,
      templateId:  receiptTemplate,
      dynamicTemplateData: {
        date,
        status:           processorResponseText,
        confirmationCode: processorAuthorizationCode,
        cardholderName,
        cardType,
        credit,
        itemRows,
        last4,
        name,
        email,
        orderId,
        orderType,
        street1,
        street2:          formattedStreet2,
        city, 
        state, 
        zip, 
        country, 
        phone,
        shippingCost,
        subtotal,
        tax,
        total
      }
    };
    // awaiting here so we can catch all errors here and fail gracefully
    // since payment is already recieved, and we dont want the other functions
    // that run to complete the order to fail because of an issue here
    await sendgrid.send(msg);
  }
  catch (error) {
    // catch all local errors to fail gracefully
    // const {message, code, response} = error;
    // const {headers, body}           = response;
    // console.error('sendgrid error: ', message, body.errors);
    console.error('sendReceiptEmail failed gracefully: ', error);
  }
};
// adjustInventory helper
// use a path string (ie. 'shipping.dimensions.height')
// to read a val in a nested object
const accessByPath = (path, obj) => {
  const keys = path.split('.');
  return keys.reduce((accum, key) => accum[key], obj);
};



// pull in admin and functions deps from functions/index.js
exports.init = (admin, functions) => {
  // completeOrder helper
  // take sold items out of inventory
  // only inventoryItems with an inventoryAdjust obj ({coll, doc, path, val})
  // will be updated
  const adjustInventory = async order => {
    try {
      const {inventoryAdjustments, orderType} = order;
      // services, events, etc dont have inventory adjustments
      if (!inventoryAdjustments) { 
        if (orderType !== 'pickup') {
          console.error('adjustInventory error',  order);
        }

        return; 
      }

      const adjustmentsWithRefs = inventoryAdjustments.map(adjustment => {
        const {coll, doc} = adjustment;
        const ref = admin.firestore().collection(coll).doc(doc);
        return Object.assign({}, adjustment, {ref});
      });
      // awaiting here so we can catch errors and fail gracefully 
      // so we dont stop other post order functions from finishing
      await admin.firestore().runTransaction(async transaction => {
        const getPromises = 
          adjustmentsWithRefs.map(({ref}) => 
            transaction.get(ref));
        const docs = await Promise.all(getPromises);
        const adjustmentsWithDocs = 
          adjustmentsWithRefs.map((adjustment, index) => 
            Object.assign({}, adjustment, {document: docs[index]}));

        adjustmentsWithDocs.forEach(({
          coll, 
          doc, 
          document, 
          path, 
          ref, 
          val
        }) => {
          if (!document.exists) { 
            console.error(`${coll}/${doc} does not exist!`);
            return;
          } 
          const dbData = document.data(); 
          // cannot use field to access firestore nested directly in case 
          // the field string has string values with spaces, so must walk
          // the object in js with accessByPath
          const current = accessByPath(path, dbData);
          const newQty  = Number(current) - Number(val);
          transaction.update(ref, {[path]: newQty});
        });
      });   
    }
    catch (error) {
      // catch all errors locally to fail gracefully so 
      // other post order functions are not stopped
      console.error('adjustInventory failed gracefully: ', error);
    }  
  };
  // completeOrder helper
  // create shipping labels in shippo dashboard after payment
  // transaction is successful
  // save the order to the user's data
  const makeLabelsSaveOrder = async (makeLabels, order) => {
    try {
      const {orderId, rateIds, uid} = order;
      const shippoTransactions = await makeLabels(rateIds, orderId);
      if (!uid) { return 'anonymous user'; } // anonymous user
      order.shippoTransactions = shippoTransactions; // shipping label data
      // awaiting here so as to catch all errors locally and fail gracefully
      // we dont want to halt other post order functions because of a failure here
      await admin.
              firestore().
              collection('users').
              doc(uid).
              collection('orders').
              doc(order.orderId).
              set(order);
      return null;
    }
    catch (error) {
      // consume all errors here to fail gracefully
      console.error('makeLabelsSaveOrder failed gracefully: ', error);
    }  
  };

  // triggers completeOrder firestore cloud trigger function
  const saveOrder = async order => {
    try {
      // read then increment orderId
      let id; // cannot return a val from runTransaction function
      const ref = admin.firestore().collection('ids').doc('orderId');
      await admin.firestore().runTransaction(async transaction => {
        const doc = await transaction.get(ref);      
        if (!doc.exists) { 
          console.error('ids/orderId document does not exist!');
          return;
        } 
        const orderId = doc.data().orderId + 1; // cannot return a val from runTransaction function
        id = orderId.toString();
        transaction.update(ref, {orderId});
      });
      const timestamp = Date.now(); // date is added on client to capture user timezone aware times
      // orderFulfilled used by cms order dashboard
      const orderData = Object.assign(
        {}, 
        order, 
        {orderId: id, timestamp}
      );
      // awaiting here to fail gracefully
      await admin.firestore().collection('orders').doc(id).set(orderData);
      return null;
    }
    catch (error) {    
      // MUST fail gracefully since we already have their money, no going back
      console.error(
        `
        Fatal save pay order error!!

        user id: ${order.uid}

        This means a receipt was NOT sent to user, 
        inventory adjustments were NOT made, 
        NO shipping labels where created, and 
        the order was NOT saved to user data! 
        
        error:`,       
        error,
        ' order: ',
        order    
      );
    }
  };
  // send a pick ticket to designated email address for pick tickets
  // temp workaround for easy printing
  const pickTicket = dependencies => async order => {
    try {  
      const {
        business, 
        pickTicketEmail, 
        pickTicketTemplate
      } = dependencies;  
      const {
        address, 
        date, 
        email, 
        fullName, 
        items, 
        orderId,
        orderType
      } = order;
      // address present if there are shipping items,
      // otherwise fullName will be used for name and other 
      // shipping props will not be used
      const getUserData = (addr, name) => addr ? addr : {name};
      const {
        name, 
        street1,
        street2, 
        city, 
        state, 
        zip, 
        country, 
        phone
      } = getUserData(address, fullName);    
      const msg = {
        to:         pickTicketEmail,      
        from:       business.address.email,
        subject:   `Pick Ticket Order ${orderId}`,
        templateId: pickTicketTemplate,
        dynamicTemplateData: {
          date,  
          email,      
          itemRows: items,
          orderId,
          orderType,
          name, 
          street1,
          street2, 
          city, 
          state, 
          zip, 
          country, 
          phone
        }
      };
      
      await sendgrid.send(msg); // must await to catch the error here
      return null;
    }
    catch (error) {
      console.error(error);
      throw new functions.https.HttpsError('unknown', 'generatePickTicket error', error);
    }
  };


  const makeInt = numOrStr => 
    numOrStr === undefined ? 0 : Number(numOrStr) * 100;
  const makeCurrency = num => (num / 100).toFixed(2);
  

  const adjustCredit = async data => {
    const {credit, shippingCost, subtotal, tax, uid} = data;
    const creditInt = makeInt(credit);
    // check uid for use in post-pay pickup orders
    if (creditInt > 0 && uid && uid !== 'anonymous') {
      const totInt = makeInt(subtotal) + makeInt(tax) + makeInt(shippingCost);
      const adjustedCredit = makeCurrency(Math.max(creditInt - totInt, 0));

      await admin.
        firestore().
        collection(`users/${uid}/credit`).
        doc('asg').
        set({
          credit: adjustedCredit
        });

      return adjustedCredit;
    }

    return '0.00';
  };


  const checkout = options => {
    const {
      business, 
      env
    } = options;
    const {
      apiKey,
      pickTicketEmail, 
      pickTicketTemplate, 
      receiptEmail, 
      receiptTemplate
    } = options.sendgrid;
    const {
      getShippingRates, 
      makeShippingLabels
    } = initShippo(options);
    const gateway = initGateway(env, options.braintree);
    const sendGridDependencies = {
      business, 
      pickTicketEmail,
      pickTicketTemplate,
      receiptEmail,
      receiptTemplate
    }; 
    const generatePickTicket = pickTicket(sendGridDependencies);  
    const sendReceiptEmail   = receipt(sendGridDependencies);

    sendgrid.setApiKey(apiKey);

    // add functions error handling
    const shippingRates = async (...args) => {
      try {
        const rates = await getShippingRates(...args);
        return rates;
      }
      catch (error) {
        console.error(error);
        throw new functions.https.HttpsError('unknown', error);
      }
    };

    // braintree payment integration
    const payUserToken = async ({braintreeCustomerId}) => {
      try {
        const {clientToken} = 
          await gateway.clientToken.generate({customerId: braintreeCustomerId});
        return clientToken;
      }
      catch (error) {
        console.error(error);
        throw new functions.https.HttpsError('unknown', error);
      }
    };
    // braintree payment integration
    // triggers 'completeOrder' cloud function in the background
    const pay = async data => {
      // data === {amount, email, items, nonce, rateIds, subtotal, total, tax, uid}
      const {amount, credit, items, nonce, uid} = data;
      // bail if the schema is incorrect
      const missingSchema = items.find(({amount, displayName}) => !amount || !displayName);
      if (missingSchema) {
        throw new functions.https.HttpsError(
          'invalid-argument', 
          `
            Pay schema error
            Each sold item needs the following props: 

              amount:      USD,
              displayName: human readable name
          `
        );
      }
      const amountInt = makeInt(amount);
      // credit covers full sale amount, bypass braintree
      if (amountInt === 0) { // store credit
        const adjustedCredit = await adjustCredit(data);
        const order = Object.assign(
          {}, 
          data, 
          {adjustedCredit, paidInFullWithCredit: true}
        );
        // trigger completeOrder function to run in the background        
        await saveOrder(order);
        return null;
      }
      else {
        // charge payment method
        const braintreeResult = await gateway.transaction.sale({
          amount,
          paymentMethodNonce: nonce,
          options: {
            submitForSettlement: true
          }
        });
        const {success, transaction} = braintreeResult;
        if (!success) { // declined
          console.error('Braintree unsuccessful: ', braintreeResult);
          return braintreeResult;   
        }
        // MUST run adjustCredit ONLY AFTER a successful braintree transaction
        const adjustedCredit = await adjustCredit(data); 
        // firebase does not like the transaction object as is (new operator) 
        const json  = JSON.stringify(transaction); 
        const order = Object.assign(
          {}, 
          data, 
          {
            adjustedCredit, 
            braintreeTransaction: json, 
            nonce: '', 
            paidInFullWithCredit: false
          }
        );
        // trigger completeOrder function to run in the background
        await saveOrder(order);    
        return braintreeResult;
      }
    };
    // triggerd by 'pay' callable function
    // runs in the background so 'pay' can return fast
    // run 3 tasks in parallel
    // take sold items out of inventory,
    // create shipping labels for shippable products
    // send transactional receipt email to user
    // save order and transaction data to firestore
    const completeOrder = functions.firestore.
      document('orders/{orderId}').
      onCreate(async snapShot => {
        try {
          const order = snapShot.data();
          const {braintreeTransaction: json} = order;
          // no transaction for pickup orders
          const transaction = json ? JSON.parse(json) : {};
          // run these tasks in the background so 'pay' function can return fast
          // can be run in parallel since they dont depend on one another
          await Promise.all([
            adjustInventory(order), 
            makeLabelsSaveOrder(makeShippingLabels, order), 
            sendReceiptEmail(order, transaction)
          ]);
          return null;
        }
        catch (error) {
          console.error('completeOrder error: ', error);
        }      
      });

    return {
      adjustCredit, // fulfillPickup in index.js
      adjustInventory, // fulfillPickup in index.js
      completeOrder, 
      gateway, // seedFirestoreUser triggered cloud function in index.js
      shippingRates,
      pay,
      payUserToken,
      generatePickTicket,
      saveOrder, // savePickupOrder in index.js
      sendgrid
    };
  };

  return checkout;
};
