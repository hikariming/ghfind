import {test} from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,privateDecrypt,createDecipheriv,constants} from "node:crypto";
import {encryptPreview} from "./traffic-report-preview.mjs";
test("public artifacts contain only authenticated ciphertext, decryptable by the owner",()=>{
 const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
 const html="<html>流量日报 私有统计 "+"1234567890".repeat(1000)+"</html>";
 const encoded=encryptPreview(html,publicKey),data=JSON.parse(encoded);
 assert.ok(!encoded.includes("流量日报"));assert.ok(!encoded.includes("1234567890"));
 const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(data.key,"base64"));
 const decrypt=()=>{const cipher=createDecipheriv("aes-256-gcm",key,Buffer.from(data.iv,"base64"));cipher.setAuthTag(Buffer.from(data.tag,"base64"));return Buffer.concat([cipher.update(Buffer.from(data.ciphertext,"base64")),cipher.final()]).toString();};
 assert.equal(decrypt(),html);data.tag=Buffer.alloc(16).toString("base64");assert.throws(decrypt);
});
test("missing or invalid public keys fail closed",()=>{assert.throws(()=>encryptPreview("private","invalid key"));});
