'use strict';

const binPacking3D = require('binpackingjs').BP3D; //https://github.com/olragon/binpackingjs
const {Bin, Item, Packer} = binPacking3D;

// reorder dimensions so they are always oriented in ascending order, 
// length always the smallest, width is always greatest
const normalizeDimensions = obj => {
  const {length, height, width} = obj;
  const dims = [Number(length), Number(height), Number(width)];
  const [l, h, w] = dims.sort((a, b) => a - b);
  return Object.assign({}, obj, {length: l, height: h, width: w});
};

// packer bins and items must be integers
const mm = cm => {
  const num   = Number(cm) * 10;
  const fixed = Number(num.toFixed());
  return fixed;
};
const grams = kg => Number(kg) * 1000;

// add items to packer in a proper integer format
const createPackerItems = items => {
  return items.map(item => {
    const {
      height, 
      length, 
      weight, 
      width
    } = normalizeDimensions(item.shipping);
    return new Item(item.packingId, mm(length), mm(width), mm(height), grams(weight));
  });
};

// total weights of packed items but use the boxes spacial dimensions
const getPackedBox = (packedItems, box) => {
  const totalWeight = 
    packedItems.reduce((prev, curr) => prev + Number(curr.shipping.weight), 0);
  // weight cannot be 0
  const weight = totalWeight > 0.01 ? totalWeight.toFixed(2) : '0.01';
  const customsItemsData = 
    packedItems.map(({amount, description, shipping}) => ({
      description, 
      net_weight:   Number(shipping.weight), 
      value_amount: amount
    }));
  const packedBox = 
    Object.assign({}, box, {customsItemsData, weight});
  return packedBox;
};

// format as a shippo parcel object
const createOverSizedParcels = items => items.map(item => {
  const {amount, description, displayName, shipping} = item;
  const {
    height, 
    length, 
    weight, 
    width
  } = shipping;

  return {
    distance_unit: 'cm', 
    height:         Number(height), 
    length:         Number(length), 
    mass_unit:     'kg', 
    name:           displayName, 
    customsItemsData: [{
      description, 
      net_weight:   Number(weight), 
      value_amount: amount
    }],
    weight:         Number(weight), 
    width:          Number(width)
  };
});

// use packerItem.name and item.packingId to lookup items 
// from their packerItem counterpart
const findMatchingItems = 
  (packerItems, items) => 
    packerItems.map(packerItem => 
      items.find(item => 
        packerItem.name === item.packingId));

// add a box if the largest box cannot accommodate all items and repeat the cycle
// by iterating up sizes for each box until no remainder
// if items dont fit into the largest shipping box then return a custom
// oversized parcel object and add to parcels
// return parcels needed to pack all items
// available properties after calling packer.pack(): 
// bin.items         -> items packed into a bin
// packer.items      -> packed items
// packer.unfitItems -> remaining items
const createParcels = (allItems, boxes) => {
  const largestBoxIndex = boxes.length - 1;
  const firstBox        = boxes[0];

  const packBox = (items, box, index, parcels) => {
    const {length, width, height, weight} = normalizeDimensions(box);
    const packer = new Packer();
    const bin    = new Bin(
      `bin${parcels.length}`, 
      mm(length), 
      mm(width), 
      mm(height), 
      grams(weight)
    );
    const packerItems = createPackerItems(items);
    packerItems.forEach(packerItem => packer.addItem(packerItem));
    packer.addBin(bin);
    packer.pack();

    if (packer.unfitItems.length) { // still unboxed items
      if (index < largestBoxIndex) { // try a bigger box
        const nextIndex   = index + 1;
        const nextSizeBox = boxes[nextIndex];
        return packBox(items, nextSizeBox, nextIndex, parcels);
      }
      else if (bin.items.length === 0) { // item(s) too big to fit largest available box
        const overSizedParcels = createOverSizedParcels(items);
        return [...parcels, ...overSizedParcels];
      }
      else { // largest box filled, add another box for remaining items
        const packedItems    = findMatchingItems(bin.items, items);
        const remainingItems = findMatchingItems(packer.unfitItems, items);
        const packedBox      = getPackedBox(packedItems, box);
        return packBox(remainingItems, firstBox, 0, [...parcels, packedBox]);
      }
    }
    const packedBox = getPackedBox(items, box);
    return [...parcels, packedBox];
  };

  return packBox(allItems, firstBox, 0, []);
};

module.exports = createParcels;
