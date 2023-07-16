// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore, collection, setDoc, onSnapshot, addDoc, getDoc, updateDoc, doc } from "firebase/firestore";
import firebaseConfig from './secret.json';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const firestore = getFirestore(app);
const chunkSize = 1024; // Chunk size in bytes
let filesToRead = [];
let assembleDataChunks = [];
const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

// Global State
const pc = new RTCPeerConnection(servers);
let sendersChannel = pc.createDataChannel('Data Transfer');
let localMediaStream = null;
let remoteMediaStream = null;

pc.addEventListener('datachannel', (event) => {
  console.log('got datachannel notification');
  let receiveChannel = event.channel;
  receiveChannel.addEventListener('message', (ev) => {
    download(ev.data);
  });
  receiveChannel.addEventListener('error', (ev) => {
    console.log(ev);
  })
  receiveChannel.addEventListener('close', (ev) => {
    console.log('closed', ev);
  })
})

sendersChannel.addEventListener('message', (ev) => {
  download(ev.data);
});

sendersChannel.addEventListener('error', (ev) => {
  console.log(ev);
})

sendersChannel.addEventListener('open', (ev) => {
  sendButton.addEventListener('click', () => {
    for (let i = 0; i < filesToRead.length; i++) {
      const file = filesToRead[i];
      let offset = 0;
      let data = {
        'name': file.name,
        'type': file.type,
        'isLast': false
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const chunk = e.target.result;
        data.content = chunk.split(',')[1];
        sendersChannel.send(JSON.stringify(data));
        offset += chunkSize;
        if (offset < file.size) {
          if (offset + chunkSize > file.size) {
            data.isLast = true
          }
          readNextChunk();
        } else {
          console.log(`File ${file.name} reading complete`);
        }
      };
      const readNextChunk = () => {
        const slice = file.slice(offset, offset + chunkSize);
        reader.readAsDataURL(slice);
      };
      readNextChunk();
    }

  }
  )
})

// HTML elements
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput');
const answerButton = document.getElementById('answerButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');
const fileInput = document.getElementById('fileShare');
const sendButton = document.getElementById('sendButton');

fileInput.addEventListener('change', (event) => {
  filesToRead = event.target.files;
  console.log(filesToRead);
});


webcamButton.onclick = async () => {
  localMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  remoteMediaStream = new MediaStream();
  // Push tracks from local stream to peer connection
  localMediaStream.getTracks().forEach((track) => {
    pc.addTrack(track, localMediaStream);
  });

  // Pull tracks from remote stream, add to video stream
  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteMediaStream.addTrack(track);
    });
  };

  webcamVideo.srcObject = localMediaStream;
  remoteVideo.srcObject = remoteMediaStream;

  callButton.disabled = false;
  answerButton.disabled = false;
  webcamButton.disabled = true;
};

// 2. Create an offer
callButton.onclick = async () => {
  // Reference Firestore collections for signaling 
  const callDoc = doc(collection(firestore, 'calls'));
  const offerCandidates = collection(callDoc, 'offerCandidates');
  const answerCandidates = collection(callDoc, 'answerCandidates');

  callInput.value = callDoc.id;

  // Get candidates for caller, save to db
  pc.onicecandidate = (event) => {
    event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
  };

  // Create offer
  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  const offer = {
    sdp: offerDescription.sdp,
    type: offerDescription.type,
  };
  await setDoc(callDoc, { offer });


  // Listen for remote answer
  onSnapshot(callDoc, (snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

  // When answered, add candidate to peer connection
  onSnapshot(answerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });

  hangupButton.disabled = false;
};

// 3. Answer the call with the unique ID

answerButton.onclick = async () => {
  const callId = callInput.value;
  const callDoc = doc(firestore, 'calls', callId);
  const answerCandidates = collection(callDoc, 'answerCandidates');
  const offerCandidates = collection(callDoc, 'offerCandidates');
  pc.onicecandidate = (event) => {
    event.candidate && addDoc(answerCandidates, event.candidate.toJSON());
  };
  const callData = (await getDoc(callDoc)).data();
  const offerDescription = callData.offer;
  await pc.setRemoteDescription(new RTCSessionDescription(offerDescription));
  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);
  const answer = {
    type: answerDescription.type,
    sdp: answerDescription.sdp,
  };
  await updateDoc(callDoc, { answer });
  onSnapshot(offerCandidates, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      console.log(change);
      if (change.type === 'added') {
        let data = change.doc.data();
        pc.addIceCandidate(new RTCIceCandidate(data));
      }
    });
  });
};



function download(receivedData) {
  receivedData = JSON.parse(receivedData);
  const fileName = receivedData.name;
  const fileType = receivedData.type;
  if (receivedData.isLast) {
    assembleDataChunks.push(base64ToBlob(receivedData.content));
    const blob = new Blob(assembleDataChunks, { type: fileType });

    // Create a temporary anchor element to trigger the file download
    const anchorElement = document.createElement('a');
    anchorElement.href = URL.createObjectURL(blob);
    anchorElement.download = fileName;

    // Programmatically click the anchor element to initiate the file download
    anchorElement.click();
    assembleDataChunks = [];
  } else {
    assembleDataChunks.push(base64ToBlob(receivedData.content));
  }

  // Create a Blob object from the received data
  // let fileStream = null;
  // if (fileStream === null) {
  //   // Create a writable stream to write the received chunks to a file
  //   fileStream = new WritableStream({
  //     write(chunk) {
  //       // Write the chunk to the file stream
  //       return this.getWriter().then((writer) => {
  //         writer.write(chunk);
  //         writer.releaseLock();
  //       });
  //     }
  //   });
  // }
  // // Write the received chunk to the file stream
  // fileStream.write(chunk);
};



//Nanga jugaaadd.. chatgpt gave  below function, it works... but till date i dont know how??
function base64ToBlob(base64Data) {

  const byteCharacters = atob(base64Data);
  const byteArrays = [];

  for (let offset = 0; offset < byteCharacters.length; offset += 512) {
    const slice = byteCharacters.slice(offset, offset + 512);

    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }

  return new Blob(byteArrays);
}






